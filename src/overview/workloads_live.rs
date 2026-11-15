//! The live Workloads overview: a watch per workload kind (and of warning
//! events) per selected namespace, folded into [`WorkloadSummary`]s and
//! turned into a [`WorkloadsOverview`] at most once per [`THROTTLE`], only
//! when something changed. The same parts and RBAC handling as the cluster
//! overview (`live`): across all namespaces, a refused kind falls back to
//! the context's namespace; in a picked namespace, it is left out there,
//! with a note.

use super::live::{api, config, trim_events, Keyed, Part, THROTTLE};
use super::summary;
use super::workloads::{self, WorkloadSummary, WorkloadsOverview, LABELS};
use super::EventInfo;
use crate::resources::WORKLOAD_KINDS;
use crate::watch::{watch_summaries, Update, WatchState};
use futures::stream::{self, BoxStream, SelectAll};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::VecDeque;
use std::fmt::Debug;

/// Warning events in a summary.
const EVENTS_SHOWN: usize = 20;

/// What [`watch_workloads`] yields.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkloadsUpdate {
    /// A new summary, sent when it differs from the previous one.
    Summary(Box<WorkloadsOverview>),
    /// `Connecting` until every watch has its first list, `Live` after,
    /// `Reconnecting` while one is failing. Never `Forbidden`: a refused
    /// kind is narrowed or left out, with a note.
    State(WatchState),
}

/// Watch the workloads in `namespaces` (empty: all namespaces, falling
/// back to the context's namespace for kinds the user may not list across
/// the cluster). The stream never ends on its own; drop it to stop.
pub fn watch_workloads(
    client: &Client,
    namespaces: &[String],
) -> BoxStream<'static, WorkloadsUpdate> {
    let live = Live::new(client.clone(), namespaces);
    stream::unfold(live, |mut live| async move {
        let next = live.next().await;
        Some((next, live))
    })
    .boxed()
}

enum Msg {
    /// An update of the kinds part at this index.
    Kind(usize, Update<Keyed<WorkloadSummary>>),
    /// An update of the events part at this index.
    Events(usize, Update<Keyed<EventInfo>>),
}

fn typed<K>(client: &Client, kind: usize, ns: Option<&str>, part: usize) -> BoxStream<'static, Msg>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope, DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Serialize
        + Debug
        + Send
        + 'static,
{
    watch_summaries(api::<K>(client, ns), config(), move |o: &K| {
        let v = serde_json::to_value(o).unwrap_or_default();
        let s = workloads::workload_summary(kind, &v);
        (format!("{}/{}", s.namespace, s.name), s)
    })
    .map(move |u| Msg::Kind(part, u))
    .boxed()
}

/// The watch of `WORKLOAD_KINDS[kind]` in `ns` (`None`: all namespaces).
fn kind_stream(
    client: &Client,
    kind: usize,
    ns: Option<&str>,
    part: usize,
) -> BoxStream<'static, Msg> {
    match kind {
        0 => typed::<Pod>(client, kind, ns, part),
        1 => typed::<Deployment>(client, kind, ns, part),
        2 => typed::<DaemonSet>(client, kind, ns, part),
        3 => typed::<StatefulSet>(client, kind, ns, part),
        4 => typed::<ReplicaSet>(client, kind, ns, part),
        5 => typed::<Job>(client, kind, ns, part),
        _ => typed::<CronJob>(client, kind, ns, part),
    }
}

fn events_stream(client: &Client, ns: Option<&str>, part: usize) -> BoxStream<'static, Msg> {
    let config = config().fields("type=Warning");
    watch_summaries(api::<Event>(client, ns), config, |e: &Event| {
        let info = summary::event_info(e);
        (info.key.clone(), info)
    })
    .map(move |u| Msg::Events(part, u))
    .boxed()
}

struct Live {
    client: Client,
    /// The namespaces picked (empty: all namespaces).
    picked: Vec<String>,
    /// Where an all-namespaces watch falls back to after a 403.
    fallback: String,
    streams: SelectAll<BoxStream<'static, Msg>>,
    /// One part per (kind, scope), kind-major; `kind_of[i]` is part i's kind.
    parts: Vec<Part<WorkloadSummary>>,
    kind_of: Vec<usize>,
    /// One part per scope.
    events: Vec<Part<EventInfo>>,
    dirty: bool,
    tick: Option<tokio::time::Interval>,
    last: Option<WorkloadsOverview>,
    state: Option<WatchState>,
    out: VecDeque<WorkloadsUpdate>,
}

impl Live {
    fn new(client: Client, namespaces: &[String]) -> Self {
        let scopes: Vec<Option<String>> = if namespaces.is_empty() {
            vec![None]
        } else {
            namespaces.iter().cloned().map(Some).collect()
        };
        let mut streams = Vec::new();
        let mut parts = Vec::new();
        let mut kind_of = Vec::new();
        for (kind, label) in LABELS.iter().enumerate() {
            for scope in &scopes {
                streams.push(kind_stream(&client, kind, scope.as_deref(), parts.len()));
                let mut part = Part::new(label, true);
                // A part already in a namespace is left out on a 403.
                part.scope = scope.clone();
                parts.push(part);
                kind_of.push(kind);
            }
        }
        let mut events = Vec::new();
        for scope in &scopes {
            streams.push(events_stream(&client, scope.as_deref(), events.len()));
            let mut part = Part::new("Events", true);
            part.scope = scope.clone();
            events.push(part);
        }
        Self {
            fallback: client.default_namespace().to_string(),
            client,
            picked: namespaces.to_vec(),
            streams: stream::select_all(streams),
            parts,
            kind_of,
            events,
            dirty: true,
            tick: None,
            last: None,
            state: None,
            out: VecDeque::new(),
        }
    }

    async fn next(&mut self) -> WorkloadsUpdate {
        loop {
            if let Some(update) = self.out.pop_front() {
                return update;
            }
            let tick = self.tick.get_or_insert_with(|| {
                let mut t = tokio::time::interval(THROTTLE);
                t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                t
            });
            tokio::select! {
                Some(msg) = self.streams.next(), if !self.streams.is_empty() => {
                    self.handle(msg);
                    if self.last.is_none() && self.ready() {
                        self.flush();
                    }
                }
                _ = tick.tick() => self.flush(),
            }
        }
    }

    fn handle(&mut self, msg: Msg) {
        let fallback = self.fallback.clone();
        let changed = match msg {
            Msg::Kind(i, u) => match self.parts[i].apply(u) {
                Ok(changed) => changed,
                Err(()) => {
                    if self.parts[i].refused(&fallback) {
                        let kind = self.kind_of[i];
                        self.streams
                            .push(kind_stream(&self.client, kind, Some(&fallback), i));
                    }
                    true
                }
            },
            Msg::Events(i, u) => match self.events[i].apply(u) {
                Ok(changed) => {
                    let part = &mut self.events[i];
                    part.items.retain(|_, e| workloads::about_a_workload(e));
                    trim_events(&mut part.items);
                    changed
                }
                Err(()) => {
                    if self.events[i].refused(&fallback) {
                        self.streams
                            .push(events_stream(&self.client, Some(&fallback), i));
                    }
                    true
                }
            },
        };
        self.dirty |= changed;
    }

    fn ready(&self) -> bool {
        self.parts.iter().all(Part::ready) && self.events.iter().all(Part::ready)
    }

    fn flush(&mut self) {
        let ready = self.ready();
        if ready && self.dirty {
            self.dirty = false;
            let overview = self.summarize();
            if self.last.as_ref() != Some(&overview) {
                self.last = Some(overview.clone());
                self.out
                    .push_back(WorkloadsUpdate::Summary(Box::new(overview)));
            }
        }
        let error = self
            .parts
            .iter()
            .map(|p| &p.error)
            .chain(self.events.iter().map(|p| &p.error))
            .find_map(Clone::clone);
        let state = match error {
            Some(error) => WatchState::Reconnecting { error },
            None if ready => WatchState::Live,
            None => WatchState::Connecting,
        };
        if self.state.as_ref() != Some(&state) {
            self.state = Some(state.clone());
            self.out.push_back(WorkloadsUpdate::State(state));
        }
    }

    /// Why the parts of one kind (or the events) are narrowed or missing.
    fn note<T>(&self, label: &str, parts: &[&Part<T>]) -> Option<String> {
        if self.picked.is_empty() {
            return parts.first().and_then(|p| p.note(&self.fallback));
        }
        let denied: Vec<&str> = parts
            .iter()
            .filter(|p| p.denied)
            .filter_map(|p| p.scope.as_deref())
            .collect();
        match denied.len() {
            0 => None,
            1 => Some(format!("{label}: not allowed in namespace {}", denied[0])),
            _ => Some(format!(
                "{label}: not allowed in namespaces {}",
                denied.join(", ")
            )),
        }
    }

    fn summarize(&self) -> WorkloadsOverview {
        let mut kinds = Vec::new();
        let mut notes = Vec::new();
        for (kind, label) in LABELS.iter().enumerate() {
            let parts: Vec<&Part<WorkloadSummary>> = self
                .parts
                .iter()
                .zip(&self.kind_of)
                .filter(|(_, &k)| k == kind)
                .map(|(p, _)| p)
                .collect();
            notes.extend(self.note(label, &parts));
            if parts.iter().any(|p| !p.denied) {
                let items = parts.iter().flat_map(|p| p.items.values());
                kinds.push(workloads::kind_counts(kind, items));
            }
        }
        let (problems, problems_total) = workloads::problems(
            self.parts
                .iter()
                .zip(&self.kind_of)
                .flat_map(|(p, &k)| p.items.values().map(move |w| (k, w))),
        );
        let events: Vec<&Part<EventInfo>> = self.events.iter().collect();
        notes.extend(self.note("Events", &events));
        debug_assert_eq!(LABELS.len(), WORKLOAD_KINDS.len());
        WorkloadsOverview {
            kinds,
            problems,
            problems_total,
            events: summary::newest_events(
                self.events.iter().flat_map(|p| p.items.values()),
                EVENTS_SHOWN,
            ),
            notes,
        }
    }
}
