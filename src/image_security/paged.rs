//! Reading a list of reports in small pages, up to a cap, for the report
//! kinds without a typed client (ConfigAuditReports, Kubescape's
//! summaries). Like [`super::trivy_operator::list_summaries`]: each page is
//! reduced (`keep`) as it is parsed, so only what a listing shows stays in
//! memory.

use kube::api::ListParams;
use kube::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// Reports asked for per request.
pub(crate) const PAGE_SIZE: u32 = 20;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ListMeta {
    #[serde(rename = "continue")]
    continue_: String,
}

#[derive(Debug, Deserialize)]
#[serde(default, bound(deserialize = "T: DeserializeOwned"))]
struct RawList<T> {
    metadata: ListMeta,
    items: Vec<T>,
}

impl<T> Default for RawList<T> {
    fn default() -> Self {
        RawList {
            metadata: ListMeta::default(),
            items: Vec::new(),
        }
    }
}

/// What [`list_paged`] read.
#[derive(Debug)]
pub(crate) struct Paged<U> {
    pub(crate) items: Vec<U>,
    /// More exist than `cap` (or a continue token expired).
    pub(crate) more: bool,
}

/// `/apis/<group>/<version>[/namespaces/<ns>]/<plural>`.
pub(crate) fn url_path(group: &str, version: &str, plural: &str, ns: Option<&str>) -> String {
    match ns {
        Some(ns) => format!("/apis/{group}/{version}/namespaces/{ns}/{plural}"),
        None => format!("/apis/{group}/{version}/{plural}"),
    }
}

/// Most pages one listing asks for beyond what `cap` needs: a server that
/// keeps answering empty pages with a continue token ends the read.
const EXTRA_PAGES: usize = 10;

/// The objects at `path`, at most `cap`, in pages of [`PAGE_SIZE`], each
/// kept as `keep` makes it (`None`: dropped, still counted against `cap`).
///
/// `resource_version` goes on every page, continue pages too (Kubescape's
/// storage sends the spec only with `resourceVersion=fullSpec`, and decides
/// per request). A server that refuses it on the first page (400: a plain
/// CRD, where it is not a valid resourceVersion) is asked again without it.
pub(crate) async fn list_paged<T, U>(
    client: &Client,
    path: &str,
    cap: usize,
    resource_version: Option<&str>,
    keep: impl Fn(T) -> Option<U>,
) -> kube::Result<Paged<U>>
where
    T: DeserializeOwned,
{
    let cap = cap.max(1);
    let mut out = Paged {
        items: Vec::new(),
        more: false,
    };
    let max_pages = cap.div_ceil(PAGE_SIZE as usize) + EXTRA_PAGES;
    let mut rv = resource_version;
    let mut pages = 0usize;
    let mut read = 0usize;
    let mut token = String::new();
    loop {
        if pages >= max_pages {
            out.more = true;
            break;
        }
        let left = cap - read;
        let mut lp = ListParams::default().limit(PAGE_SIZE.min(left as u32).max(1));
        let continuing = !token.is_empty();
        if continuing {
            lp.continue_token = Some(token.clone());
        }
        let req = list_request(path, &lp, rv)?;
        let list: RawList<T> = match client.request(req).await {
            Ok(l) => l,
            Err(kube::Error::Api(resp)) if continuing && resp.code == 410 => {
                out.more = true;
                return Ok(out);
            }
            Err(kube::Error::Api(resp)) if !continuing && rv.is_some() && resp.code == 400 => {
                rv = None;
                continue;
            }
            Err(e) => return Err(e),
        };
        pages += 1;
        for item in list.items.into_iter().take(cap - read) {
            read += 1;
            if let Some(u) = keep(item) {
                out.items.push(u);
            }
        }
        token = list.metadata.continue_;
        if token.is_empty() {
            break;
        }
        if read >= cap {
            out.more = true;
            break;
        }
    }
    Ok(out)
}

/// A list request with `resource_version` on it, continue page or not
/// (kube leaves it out of a continue page).
fn list_request(
    path: &str,
    lp: &ListParams,
    resource_version: Option<&str>,
) -> kube::Result<http::Request<Vec<u8>>> {
    let mut req = kube::core::Request::new(path)
        .list(lp)
        .map_err(kube::Error::BuildRequest)?;
    if let Some(rv) = resource_version {
        let rv: String = rv
            .bytes()
            .filter(|b| b.is_ascii_alphanumeric())
            .map(char::from)
            .collect();
        let uri = req.uri().to_string();
        let sep = if uri.contains('?') { '&' } else { '?' };
        if let Ok(u) = format!("{uri}{sep}resourceVersion={rv}").parse() {
            *req.uri_mut() = u;
        }
    }
    Ok(req)
}

/// One object at `path/name`.
pub(crate) async fn get<T: DeserializeOwned>(
    client: &Client,
    path: &str,
    name: &str,
) -> kube::Result<T> {
    let req = kube::core::Request::new(path)
        .get(name, &Default::default())
        .map_err(kube::Error::BuildRequest)?;
    client.request(req).await
}

/// Whether discovery serves `plural` in `group/version` (a 404 or a 503:
/// no).
pub(crate) async fn served(
    client: &Client,
    group: &str,
    version: &str,
    plural: &str,
) -> kube::Result<bool> {
    match client
        .list_api_group_resources(&format!("{group}/{version}"))
        .await
    {
        Ok(list) => Ok(list.resources.iter().any(|r| r.name == plural)),
        // 503: an aggregated API (Kubescape's storage) whose server is
        // down or gone: nothing to read there.
        Err(kube::Error::Api(resp)) if resp.code == 404 || resp.code == 503 => Ok(false),
        Err(e) => Err(e),
    }
}
