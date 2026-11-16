//! The live Applications view (#226): a watch per kind of
//! [`APP_KINDS`] per selected namespace, folded into [`AppObject`]s and
//! grouped into an [`ApplicationsList`] at most once per [`THROTTLE`], only
//! when something changed. RBAC as in the Workloads overview: across all
//! namespaces, a refused kind falls back to the context's namespace; in a
//! picked namespace, it is left out there, with a note.

use super::live::{api, config, Keyed, Part, THROTTLE};
use crate::applications::{app_object, group_applications, AppObject, ApplicationsList, APP_KINDS};
use crate::liveness::Prober;
use crate::watch::{watch_summaries, Update, WatchState};
use futures::stream::{self, BoxStream, SelectAll};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use kube::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::VecDeque;
use std::fmt::Debug;

/// The kinds of [`APP_KINDS`], with their plural for notes.
const LABELS: [&str; 5] = [
    "Deployments",
    "StatefulSets",
    "DaemonSets",
    "CronJobs",
    "Jobs",
];

/// What [`watch_applications`] yields.
#[derive(Debug, Clone, PartialEq)]
pub enum ApplicationsUpdate {
    /// A new list, sent when it differs from the previous one.
    List(Box<ApplicationsList>),
    /// `Connecting` until every watch has its first list, `Live` after,
    /// `Reconnecting` while one is failing. Never `Forbidden`: a refused
    /// kind is narrowed or left out, with a note.
    State(WatchState),
}

/// Watch the applications in `namespaces` (empty: all namespaces, falling
/// back to the context's namespace for kinds the user may not list across
/// the cluster). The stream never ends on its own; drop it to stop.
pub fn watch_applications(
    client: &Client,
    prober: &Prober,
    namespaces: &[String],
) -> BoxStream<'static, ApplicationsUpdate> {
    let live = Live::new(client.clone(), prober.clone(), namespaces);
    stream::unfold(live, |mut live| async move {
        let next = live.next().await;
        Some((next, live))
    })
    .boxed()
}

/// An update of the part at this index. Objects that are not part of an
/// application are kept as `None`, so a label removed later drops them.
type Msg = (usize, Update<Keyed<Option<AppObject>>>);

fn typed<K>(
    client: &Client,
    prober: &Prober,
    kind: usize,
    ns: Option<&str>,
    part: usize,
) -> BoxStream<'static, Msg>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope, DynamicType = ()>
        + Clone
        + DeserializeOwned
        + Serialize
        + Debug
        + Send
        + 'static,
{
    let (group, k) = APP_KINDS[kind];
    watch_summaries(api::<K>(client, ns), prober, config(), move |o: &K| {
        let v = serde_json::to_value(o).unwrap_or_default();
        let key = format!(
            "{}/{}",
            o.meta().namespace.as_deref().unwrap_or_default(),
            o.meta().name.as_deref().unwrap_or_default()
        );
        (key, app_object(group, k, &v))
    })
    .map(move |u| (part, u))
    .boxed()
}

fn kind_stream(
    client: &Client,
    prober: &Prober,
    kind: usize,
    ns: Option<&str>,
    part: usize,
) -> BoxStream<'static, Msg> {
    match kind {
        0 => typed::<Deployment>(client, prober, kind, ns, part),
        1 => typed::<StatefulSet>(client, prober, kind, ns, part),
        2 => typed::<DaemonSet>(client, prober, kind, ns, part),
        3 => typed::<CronJob>(client, prober, kind, ns, part),
        _ => typed::<Job>(client, prober, kind, ns, part),
    }
}

struct Live {
    client: Client,
    prober: Prober,
    picked: Vec<String>,
    fallback: String,
    streams: SelectAll<BoxStream<'static, Msg>>,
    /// One part per (kind, scope), kind-major; `kind_of[i]` is part i's kind.
    parts: Vec<Part<Option<AppObject>>>,
    kind_of: Vec<usize>,
    dirty: bool,
    tick: Option<tokio::time::Interval>,
    last: Option<ApplicationsList>,
    state: Option<WatchState>,
    out: VecDeque<ApplicationsUpdate>,
}

impl Live {
    fn new(client: Client, prober: Prober, namespaces: &[String]) -> Self {
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
                streams.push(kind_stream(
                    &client,
                    &prober,
                    kind,
                    scope.as_deref(),
                    parts.len(),
                ));
                let mut part = Part::new(label, true);
                part.scope = scope.clone();
                parts.push(part);
                kind_of.push(kind);
            }
        }
        Self {
            fallback: client.default_namespace().to_string(),
            client,
            prober,
            picked: namespaces.to_vec(),
            streams: stream::select_all(streams),
            parts,
            kind_of,
            dirty: true,
            tick: None,
            last: None,
            state: None,
            out: VecDeque::new(),
        }
    }

    async fn next(&mut self) -> ApplicationsUpdate {
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

    fn handle(&mut self, (i, update): Msg) {
        let changed = match self.parts[i].apply(update) {
            Ok(changed) => changed,
            Err(()) => {
                let fallback = self.fallback.clone();
                if self.parts[i].refused(&fallback) {
                    self.streams.push(kind_stream(
                        &self.client,
                        &self.prober,
                        self.kind_of[i],
                        Some(&fallback),
                        i,
                    ));
                }
                true
            }
        };
        self.dirty |= changed;
    }

    fn ready(&self) -> bool {
        self.parts.iter().all(Part::ready)
    }

    fn flush(&mut self) {
        let ready = self.ready();
        if ready && self.dirty {
            self.dirty = false;
            let list = self.summarize();
            if self.last.as_ref() != Some(&list) {
                self.last = Some(list.clone());
                self.out.push_back(ApplicationsUpdate::List(Box::new(list)));
            }
        }
        let state = match self.parts.iter().find_map(|p| p.error.clone()) {
            Some(error) => WatchState::Reconnecting { error },
            None if ready => WatchState::Live,
            None => WatchState::Connecting,
        };
        if self.state.as_ref() != Some(&state) {
            self.state = Some(state.clone());
            self.out.push_back(ApplicationsUpdate::State(state));
        }
    }

    /// Why the parts of one kind are narrowed or missing.
    fn note(&self, label: &str, parts: &[&Part<Option<AppObject>>]) -> Option<String> {
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

    fn summarize(&self) -> ApplicationsList {
        let notes = LABELS
            .iter()
            .enumerate()
            .filter_map(|(kind, label)| {
                let parts: Vec<&Part<Option<AppObject>>> = self
                    .parts
                    .iter()
                    .zip(&self.kind_of)
                    .filter(|(_, &k)| k == kind)
                    .map(|(p, _)| p)
                    .collect();
                self.note(label, &parts)
            })
            .collect();
        let objects = self.parts.iter().flat_map(|p| p.items.values().flatten());
        ApplicationsList {
            applications: group_applications(objects),
            notes,
        }
    }
}
