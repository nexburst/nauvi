//! Docker Hub's own API, for the dates of tags (the distribution API has
//! none): `hub.docker.com/v2/namespaces/<ns>/repositories/<name>/tags`,
//! newest first. Anonymous, best effort: a failure only leaves the dates
//! out.

use super::http::{Https, Reply};
use http::{Method, Uri};
use std::collections::HashMap;

/// Docker Hub's API host.
pub(crate) const HUB_API: &str = "hub.docker.com";
/// Pages of 100 read (the newest 300 tags).
const MAX_PAGES: usize = 3;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;

/// Tag -> when it was last pushed (RFC 3339), for the newest tags of
/// `repository` (`library/mongo`). `hub` is Docker Hub's API authority.
pub(crate) async fn tag_dates(http: &Https, hub: &str, repository: &str) -> HashMap<String, String> {
    let mut dates = HashMap::new();
    let Some((ns, name)) = repository.split_once('/') else {
        return dates;
    };
    let first = format!(
        "https://{hub}/v2/namespaces/{ns}/repositories/{name}/tags?page_size=100&ordering=last_updated"
    );
    let mut next: Option<Uri> = first.parse().ok();
    for _ in 0..MAX_PAGES {
        let Some(uri) = next.take() else { break };
        let Ok(reply) = http.send(Method::GET, uri, &[], MAX_PAGE_BYTES).await else {
            break;
        };
        if !reply.status.is_success() {
            break;
        }
        next = read_page(&reply, hub, &mut dates);
    }
    dates
}

/// Add one page's dates; the next page if it is on `hub`.
fn read_page(reply: &Reply, hub: &str, dates: &mut HashMap<String, String>) -> Option<Uri> {
    let v: serde_json::Value = serde_json::from_slice(&reply.body).ok()?;
    for r in v.get("results")?.as_array()? {
        if let (Some(name), Some(when)) = (
            r.get("name").and_then(|n| n.as_str()),
            r.get("last_updated").and_then(|n| n.as_str()),
        ) {
            if super::reference::is_tag(name) && when.len() <= 40 {
                dates.insert(name.to_string(), when.to_string());
            }
        }
    }
    let next: Uri = v.get("next")?.as_str()?.parse().ok()?;
    (next.scheme_str() == Some("https")
        && next.authority().map(|a| a.as_str()) == Some(hub))
    .then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(body: &str) -> Reply {
        Reply {
            status: http::StatusCode::OK,
            headers: Default::default(),
            body: bytes::Bytes::from(body.to_string()),
            uri: "https://hub.docker.com/".parse().unwrap(),
        }
    }

    #[test]
    fn reads_dates_and_follows_only_pages_on_the_hub() {
        let mut d = HashMap::new();
        let next = read_page(
            &reply(
                r#"{"next":"https://hub.docker.com/v2/namespaces/library/repositories/mongo/tags?page=2","results":[
                {"name":"7.0.2","last_updated":"2026-10-01T10:00:00.000Z"},{"name":"bad tag","last_updated":"x"}]}"#,
            ),
            "hub.docker.com",
            &mut d,
        );
        assert!(next.is_some());
        assert_eq!(d.len(), 1);
        assert_eq!(d["7.0.2"], "2026-10-01T10:00:00.000Z");
        let elsewhere = read_page(&reply(r#"{"next":"https://evil.com/p2","results":[]}"#), "hub.docker.com", &mut d);
        assert!(elsewhere.is_none());
        assert!(read_page(&reply(r#"{"next":null,"results":[]}"#), "hub.docker.com", &mut d).is_none());
    }
}
