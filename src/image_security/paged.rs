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

/// The objects at `path`, at most `cap`, in pages of [`PAGE_SIZE`], each
/// kept as `keep` makes it (`None`: dropped, still counted against `cap`).
pub(crate) async fn list_paged<T, U>(
    client: &Client,
    path: &str,
    cap: usize,
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
    let mut read = 0usize;
    let mut token = String::new();
    loop {
        let left = cap - read;
        let mut lp = ListParams::default().limit(PAGE_SIZE.min(left as u32).max(1));
        let continuing = !token.is_empty();
        if continuing {
            lp.continue_token = Some(std::mem::take(&mut token));
        }
        let req = kube::core::Request::new(path)
            .list(&lp)
            .map_err(kube::Error::BuildRequest)?;
        let list: RawList<T> = match client.request(req).await {
            Ok(l) => l,
            Err(kube::Error::Api(resp)) if continuing && resp.code == 410 => {
                out.more = true;
                return Ok(out);
            }
            Err(e) => return Err(e),
        };
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

/// Whether discovery serves `plural` in `group/version` (a 404: no).
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
        Err(kube::Error::Api(resp)) if resp.code == 404 => Ok(false),
        Err(e) => Err(e),
    }
}
