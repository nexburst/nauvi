//! The ready backends of a forward, remembered between connections (#374).
//!
//! Listing EndpointSlices (a Service) or Pods (a workload, or a pod for its
//! UID, #399) is one more API
//! round trip before a new local connection can start. So a forward
//! watches them and lists only after something changed: while the watch
//! runs, a remembered list stays valid until the next change. When it does
//! not run (it failed, or is not synced yet), a list younger than [`FRESH`]
//! is used as is, and one younger than [`STALE`] is used while a new one is
//! fetched. A connection that fails calls [`Backends::forget`], so the next
//! one lists again.

use super::resolve::{Backend, Change, Resolver};
use anyhow::Result;
use futures::StreamExt;
use kube::Client;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

/// Without a watch, a list this young is used without asking again.
const FRESH: Duration = Duration::from_secs(3);
/// Without a watch, a list this young is used while a new one is fetched.
const STALE: Duration = Duration::from_secs(30);

pub(crate) struct Backends {
    resolver: Resolver,
    client: Client,
    namespace: String,
    state: Arc<Mutex<State>>,
    watch: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct State {
    last: Option<(Instant, Vec<Backend>)>,
    refreshing: bool,
    /// Counts changes, so a list that started before one is not kept.
    generation: u64,
    /// The watch is synced and running: `last` is current.
    watched: bool,
}

impl State {
    fn changed(&mut self) {
        self.generation += 1;
        self.last = None;
    }
}

impl Backends {
    /// Needs a Tokio runtime (it starts the watch).
    pub(crate) fn new(resolver: Resolver, client: Client, namespace: String) -> Arc<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let watch = resolver.changes(&client, &namespace).map(|mut changes| {
            let state = state.clone();
            tokio::spawn(async move {
                while let Some(change) = changes.next().await {
                    let mut s = state.lock().unwrap();
                    match change {
                        Ok(Change::Synced) => {
                            s.changed();
                            s.watched = true;
                        }
                        Ok(Change::Changed) => s.changed(),
                        Err(e) => {
                            tracing::debug!("port-forward: watching the backends: {e}");
                            s.watched = false;
                        }
                    }
                }
                state.lock().unwrap().watched = false;
            })
        });
        Arc::new(Self {
            resolver,
            client,
            namespace,
            state,
            watch,
        })
    }

    /// The ready backends, best first; empty when none is ready.
    pub(crate) async fn get(self: &Arc<Self>) -> Result<Vec<Backend>> {
        let refresh = {
            let mut s = self.state.lock().unwrap();
            let watched = s.watched;
            match &s.last {
                Some((_, list)) if watched => return Ok(list.clone()),
                Some((at, list)) if at.elapsed() < FRESH => return Ok(list.clone()),
                Some((at, list)) if at.elapsed() < STALE => {
                    let list = list.clone();
                    let start = !s.refreshing;
                    s.refreshing = true;
                    Some((list, start))
                }
                _ => None,
            }
        };
        if let Some((list, start)) = refresh {
            if start {
                let this = self.clone();
                tokio::spawn(async move {
                    let _ = this.list().await;
                    this.state.lock().unwrap().refreshing = false;
                });
            }
            return Ok(list);
        }
        self.list().await
    }

    /// List now, and remember a non-empty answer unless something changed
    /// meanwhile.
    async fn list(&self) -> Result<Vec<Backend>> {
        let generation = self.state.lock().unwrap().generation;
        let list = self
            .resolver
            .backends(&self.client, &self.namespace)
            .await?;
        let mut s = self.state.lock().unwrap();
        if s.generation == generation && !list.is_empty() {
            s.last = Some((Instant::now(), list.clone()));
        }
        Ok(list)
    }

    /// Forget the list: a connection to one of its backends failed.
    pub(crate) fn forget(&self) {
        self.state.lock().unwrap().changed();
    }
}

impl Drop for Backends {
    fn drop(&mut self) {
        if let Some(w) = &self.watch {
            w.abort();
        }
    }
}
