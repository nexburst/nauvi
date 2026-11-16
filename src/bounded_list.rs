//! Lists bounded on the server (#311): pages of `limit` objects, followed
//! with `continue` until the caller's cap, so a big cluster never sends (and
//! kubeloupe never holds) more objects than a caller will use.

use kube::api::{Api, ListParams};
use kube::Resource;
use serde::de::DeserializeOwned;
use std::fmt::Debug;

/// Objects asked for per request.
pub const PAGE_SIZE: u32 = 500;

/// What [`list_bounded`] read.
#[derive(Debug)]
pub struct Bounded<K> {
    /// At most `cap` objects, in the API server's order.
    pub items: Vec<K>,
    /// More objects match than were read.
    pub more: bool,
}

/// At most `cap` objects that `lp` selects, read in pages of at most
/// [`PAGE_SIZE`]. `lp`'s own `limit` and `continue` are replaced.
pub async fn list_bounded<K>(api: &Api<K>, lp: &ListParams, cap: usize) -> kube::Result<Bounded<K>>
where
    K: Resource + Clone + DeserializeOwned + Debug,
{
    let mut items: Vec<K> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let want = page_limit(cap - items.len());
        let mut page = lp.clone().limit(want);
        page.continue_token = token.take();
        let list = api.list(&page).await?;
        items.extend(list.items);
        token = list.metadata.continue_.filter(|c| !c.is_empty());
        if items.len() >= cap || token.is_none() {
            break;
        }
    }
    let more = token.is_some() || items.len() > cap;
    items.truncate(cap);
    Ok(Bounded { items, more })
}

/// The `limit` of the next page when `left` more objects are wanted.
fn page_limit(left: usize) -> u32 {
    u32::try_from(left).unwrap_or(u32::MAX).clamp(1, PAGE_SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use kube::client::Body;
    use std::sync::{Arc, Mutex};

    /// A fake API server with `total` pods, in pages of what is asked for,
    /// that records each request's query.
    fn server(total: usize) -> (kube::Client, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let svc = tower::service_fn(move |req: http::Request<Body>| {
            let query = req.uri().query().unwrap_or_default().to_string();
            log.lock().unwrap().push(query.clone());
            let param = |name: &str| {
                query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
                    .map(str::to_string)
            };
            let limit: usize = param("limit").and_then(|l| l.parse().ok()).unwrap_or(total);
            let start: usize = param("continue").and_then(|c| c.parse().ok()).unwrap_or(0);
            let end = (start + limit).min(total);
            let items: Vec<_> = (start..end)
                .map(|i| serde_json::json!({"metadata": {"name": format!("p{i}")}}))
                .collect();
            let token = if end < total {
                end.to_string()
            } else {
                String::new()
            };
            let body = serde_json::json!({
                "apiVersion": "v1", "kind": "PodList",
                "metadata": {"continue": token}, "items": items,
            });
            async move {
                Ok::<_, std::convert::Infallible>(http::Response::new(Body::from(
                    body.to_string().into_bytes(),
                )))
            }
        });
        (kube::Client::new(svc, "default"), seen)
    }

    #[tokio::test]
    async fn stops_at_the_cap() {
        let (client, seen) = server(1200);
        let api: Api<Pod> = Api::namespaced(client, "default");
        let got = list_bounded(&api, &ListParams::default().labels("app=x"), 700)
            .await
            .unwrap();
        assert_eq!(got.items.len(), 700);
        assert!(got.more);
        assert_eq!(got.items[699].metadata.name.as_deref(), Some("p699"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].contains("limit=500") && seen[0].contains("labelSelector=app%3Dx"));
        assert!(seen[1].contains("limit=200") && seen[1].contains("continue=500"));
    }

    #[tokio::test]
    async fn reads_everything_under_the_cap() {
        let (client, seen) = server(30);
        let api: Api<Pod> = Api::namespaced(client, "default");
        let got = list_bounded(&api, &ListParams::default(), 100)
            .await
            .unwrap();
        assert_eq!(got.items.len(), 30);
        assert!(!got.more);
        assert_eq!(seen.lock().unwrap().len(), 1);

        // Exactly the cap: the server's continue token says there is more.
        let (client, _) = server(31);
        let api: Api<Pod> = Api::namespaced(client, "default");
        let got = list_bounded(&api, &ListParams::default(), 30)
            .await
            .unwrap();
        assert_eq!(got.items.len(), 30);
        assert!(got.more);
    }

    #[test]
    fn pages_are_at_most_the_page_size_and_never_empty() {
        assert_eq!(page_limit(10), 10);
        assert_eq!(page_limit(500), 500);
        assert_eq!(page_limit(501), 500);
        assert_eq!(page_limit(usize::MAX), 500);
        assert_eq!(page_limit(0), 1);
    }
}
