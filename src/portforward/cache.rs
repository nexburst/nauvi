//! The ready backends of a forward, remembered for a few seconds (#374).
//!
//! Listing EndpointSlices (a Service) or Pods (a workload) is one more
//! API round trip before a new local connection can start. A list younger
//! than [`FRESH`] is used as is; one younger than [`STALE`] is used too and
//! refreshed in the background, so a burst of connections lists once. A
//! connection that fails calls [`Backends::forget`], so the next one lists
//! again; and one whose pod is gone moves on to the next backend in the
//! list anyway.

use super::resolve::{Backend, Resolver};
use anyhow::Result;
use kube::Client;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

/// A list this young is used without asking again.
const FRESH: Duration = Duration::from_secs(3);
/// A list this young is used while a new one is fetched.
const STALE: Duration = Duration::from_secs(30);

pub(crate) struct Backends {
    resolver: Resolver,
    client: Client,
    namespace: String,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    last: Option<(Instant, Vec<Backend>)>,
    refreshing: bool,
}

impl Backends {
    pub(crate) fn new(resolver: Resolver, client: Client, namespace: String) -> Arc<Self> {
        Arc::new(Self {
            resolver,
            client,
            namespace,
            state: Mutex::default(),
        })
    }

    /// The ready backends, best first; empty when none is ready.
    pub(crate) async fn get(self: &Arc<Self>) -> Result<Vec<Backend>> {
        if !self.resolver.lists() {
            return self.list().await;
        }
        let refresh = {
            let mut s = self.state.lock().unwrap();
            match &s.last {
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

    /// List now, and remember a non-empty answer.
    async fn list(&self) -> Result<Vec<Backend>> {
        let list = self
            .resolver
            .backends(&self.client, &self.namespace)
            .await?;
        let mut s = self.state.lock().unwrap();
        s.last = (!list.is_empty()).then(|| (Instant::now(), list.clone()));
        Ok(list)
    }

    /// Forget the list: a connection to one of its backends failed.
    pub(crate) fn forget(&self) {
        self.state.lock().unwrap().last = None;
    }
}
