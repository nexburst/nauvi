//! Kinds that cannot be watched (no `watch` verb, like `componentstatuses`)
//! are listed again every so often instead.
//!
//! [`poll_with`] yields the same [`Update`]s as a watch, so the batching and
//! the UI need nothing special: a [`Update::Snapshot`] after the first list,
//! then [`Update::Applied`] / [`Update::Deleted`] for what each later list
//! changed (the batcher drops rows that look the same). The state is
//! [`WatchState::Polling`] rather than `Live`, so the UI can say the table is
//! not live.
//!
//! The lists run under a [`crate::liveness`] guard like the watches, so a
//! list that hangs on an API server that stopped answering shows as
//! Reconnecting too.

use crate::liveness::{guard_client, Guarded, Prober};
use crate::watch::{Keyed, Update, WatchState};
use futures::stream::{self, BoxStream};
use futures::StreamExt;
use kube::api::{ListParams, ObjectList};
use kube::runtime::reflector::{self, Store};
use kube::runtime::watcher::Event;
use kube::{Api, Resource};
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::fmt::Debug;
use std::hash::Hash;
use std::time::Duration;

/// Time between lists of a kind that cannot be watched.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Turns the result of each list into [`Update`]s.
struct Poller<T> {
    interval_secs: u32,
    /// The rows of the last successful list, by key; `None` before the first.
    known: Option<HashMap<String, T>>,
    /// The last list failed (only the first failure of a streak is reported).
    failing: bool,
    /// `Polling` was announced since the last failure.
    announced: bool,
    /// A 403 ended the polling.
    done: bool,
}

impl<T: Keyed + Clone> Poller<T> {
    fn new(interval: Duration) -> Self {
        Self {
            interval_secs: interval.as_secs().clamp(1, u64::from(u32::MAX)) as u32,
            known: None,
            failing: false,
            announced: false,
            done: false,
        }
    }

    fn step(&mut self, listed: Result<Vec<T>, kube::Error>) -> Vec<Update<T>> {
        let mut out = Vec::new();
        let rows = match listed {
            Err(kube::Error::Api(r)) if r.code == 403 => {
                self.done = true;
                out.push(Update::State(WatchState::Forbidden {
                    error: crate::errors::response_text(&r),
                }));
                return out;
            }
            Err(e) => return self.lost(crate::errors::chain_text(&e)),
            Ok(rows) => rows,
        };
        self.failing = false;
        let now: HashMap<String, T> = rows.iter().map(|r| (r.key(), r.clone())).collect();
        match self.known.take() {
            None => out.push(Update::Snapshot(rows)),
            Some(before) => {
                let mut gone: Vec<&T> = before
                    .iter()
                    .filter(|(k, _)| !now.contains_key(*k))
                    .map(|(_, v)| v)
                    .collect();
                gone.sort_by_key(|r| r.key());
                out.extend(gone.into_iter().cloned().map(Update::Deleted));
                out.extend(rows.into_iter().map(Update::Applied));
            }
        }
        self.known = Some(now);
        if !self.announced {
            self.announced = true;
            out.push(Update::State(WatchState::Polling {
                interval_secs: self.interval_secs,
            }));
        }
        out
    }

    /// A list failed, or the [`crate::liveness`] guard gave up on the
    /// connection. Only the first failure of a streak is reported.
    fn lost(&mut self, error: String) -> Vec<Update<T>> {
        if self.failing {
            return Vec::new();
        }
        self.failing = true;
        self.announced = false;
        vec![Update::State(WatchState::Reconnecting { error })]
    }
}

/// List `api` now and then every `interval`, keeping a reflector [`Store`]
/// of the full objects and yielding summaries (via `convert`). A failed list
/// is retried at the next interval; a 403 ends the stream after a
/// [`WatchState::Forbidden`]. Otherwise it never ends on its own; drop it to
/// stop.
pub fn poll_with<K, T>(
    api: Api<K>,
    prober: &Prober,
    dyntype: K::DynamicType,
    interval: Duration,
    convert: impl Fn(&K) -> T + Send + 'static,
) -> (Store<K>, BoxStream<'static, Update<T>>)
where
    K: Resource + Clone + DeserializeOwned + Debug + Send + Sync + 'static,
    K::DynamicType: Eq + Hash + Clone + Send + Sync + Unpin,
    T: Keyed + Clone + Send + 'static,
{
    let writer = reflector::store::Writer::new(dyntype);
    let store = writer.as_reader();
    let poller = Poller::new(interval);
    // A guard that lost the connection starts listing again, at once, when
    // the server answers.
    let lists = guard_client(prober, move || lists(api.clone(), interval));
    let updates = stream::unfold(
        (lists, writer, poller, convert),
        |(mut lists, mut writer, mut p, convert)| async move {
            if p.done {
                return None;
            }
            let out = match lists.next().await? {
                Guarded::Lost(error) => p.lost(error),
                Guarded::Item(listed) => p.step(listed.map(|list| {
                    writer.apply_watcher_event(&Event::Init);
                    for o in &list.items {
                        writer.apply_watcher_event(&Event::InitApply(o.clone()));
                    }
                    writer.apply_watcher_event(&Event::InitDone);
                    list.items.iter().map(&convert).collect()
                })),
            };
            Some((out, (lists, writer, p, convert)))
        },
    )
    .flat_map(stream::iter);
    let first = stream::once(futures::future::ready(Update::State(
        WatchState::Connecting,
    )));
    (store, first.chain(updates).boxed())
}

/// The result of listing `api` now and then every `interval`.
fn lists<K>(
    api: Api<K>,
    interval: Duration,
) -> BoxStream<'static, Result<ObjectList<K>, kube::Error>>
where
    K: Resource + Clone + DeserializeOwned + Debug + Send + Sync + 'static,
{
    stream::unfold((api, true), move |(api, first)| async move {
        if !first {
            tokio::time::sleep(interval).await;
        }
        let listed = api.list(&ListParams::default()).await;
        Some((listed, (api, false)))
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PodInfo;

    fn pod(name: &str, phase: &str) -> PodInfo {
        PodInfo {
            created: 0,
            name: name.into(),
            namespace: "a".into(),
            phase: phase.into(),
            node: String::new(),
            age: String::new(),
        }
    }

    fn api_error(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".into(),
            message: message.into(),
            reason: "x".into(),
            code,
        })
    }

    fn polling() -> Update<PodInfo> {
        Update::State(WatchState::Polling { interval_secs: 30 })
    }

    #[test]
    fn first_list_is_a_snapshot_then_polling() {
        let mut p = Poller::new(POLL_INTERVAL);
        let out = p.step(Ok(vec![pod("x", "Running")]));
        assert_eq!(
            out,
            vec![Update::Snapshot(vec![pod("x", "Running")]), polling()]
        );
    }

    #[test]
    fn later_lists_apply_everything_and_delete_what_is_gone() {
        let mut p = Poller::new(POLL_INTERVAL);
        p.step(Ok(vec![pod("x", "Running"), pod("y", "Running")]));
        let out = p.step(Ok(vec![pod("y", "Failed"), pod("z", "Pending")]));
        assert_eq!(
            out,
            vec![
                Update::Deleted(pod("x", "Running")),
                Update::Applied(pod("y", "Failed")),
                Update::Applied(pod("z", "Pending")),
            ]
        );
    }

    #[test]
    fn failures_are_reported_once_and_polling_again_after() {
        let mut p = Poller::new(POLL_INTERVAL);
        p.step(Ok(vec![]));
        let err = || Err(api_error(500, "boom"));
        assert!(matches!(
            p.step(err()).as_slice(),
            [Update::State(WatchState::Reconnecting { .. })]
        ));
        assert!(p.step(err()).is_empty());
        assert_eq!(p.step(Ok(vec![])), vec![polling()]);
        assert!(!p.done);
    }

    #[test]
    fn a_lost_connection_is_one_failure_with_its_text() {
        let mut p = Poller::new(POLL_INTERVAL);
        p.step(Ok(vec![pod("x", "Running")]));
        assert_eq!(
            p.lost("The API server is not answering".into()),
            vec![Update::State(WatchState::Reconnecting {
                error: "The API server is not answering".into()
            })]
        );
        assert!(p.step(Err(api_error(500, "boom"))).is_empty());
        assert_eq!(
            p.step(Ok(vec![pod("x", "Running")])),
            vec![Update::Applied(pod("x", "Running")), polling()]
        );
    }

    #[test]
    fn forbidden_ends_the_polling() {
        let mut p = Poller::<PodInfo>::new(POLL_INTERVAL);
        let out = p.step(Err(api_error(403, "componentstatuses is forbidden")));
        assert!(
            matches!(out.as_slice(), [Update::State(WatchState::Forbidden { error })] if error == "componentstatuses is forbidden"),
            "{out:?}"
        );
        assert!(p.done);
    }
}
