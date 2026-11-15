//! Chart repositories and charts, through the `helm` CLI: list, add,
//! remove and update repositories (`helm repo ...`), search them
//! (`helm search repo`) and show a chart's README, values and metadata
//! (`helm show ...`).
//!
//! Repositories live in the user's Helm configuration
//! (`HELM_REPOSITORY_CONFIG`, by default under `HELM_CONFIG_HOME`), shared
//! with the `helm` command line; their indexes are cached under
//! `HELM_CACHE_HOME`. Nothing here talks to the cluster.

use super::command::run_helm_with_input;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// One configured chart repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}

/// The outcome of `helm repo update`: helm reports an unreachable
/// repository but carries on with the others.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmRepoUpdate {
    /// The repositories whose index was downloaded.
    pub updated: Vec<String>,
    /// One plain sentence per repository that could not be updated.
    pub failed: Vec<String>,
}

/// One version of a chart in a repository, as `helm search repo` lists it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmChartVersion {
    /// `repo/chart`.
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

/// A row of `helm search repo -o json` (a separate type, so the IPC type
/// has no serde defaults, which would split it in TypeScript).
#[derive(Deserialize, Default)]
#[serde(default)]
struct SearchRow {
    name: String,
    version: String,
    app_version: String,
    description: String,
}

impl From<SearchRow> for HelmChartVersion {
    fn from(r: SearchRow) -> Self {
        Self {
            name: r.name,
            version: r.version,
            app_version: r.app_version,
            description: r.description,
        }
    }
}

fn parse_search(out: &str) -> Result<Vec<HelmChartVersion>> {
    if out.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<SearchRow> =
        serde_json::from_str(out).context("cannot read the output of helm search repo")?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// What `helm show` tells about one chart version.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmChartDetails {
    /// `repo/chart`, as asked.
    pub chart: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
    /// The chart's home page; empty if it names none.
    pub home: String,
    /// `README.md`; empty if the chart has none.
    pub readme: String,
    /// The chart's default `values.yaml`.
    pub values: String,
}

/// A repository name helm accepts, safe as an argument.
fn check_repo_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && name.starts_with(|c: char| c.is_ascii_alphanumeric());
    if !ok {
        bail!("{name:?} is not a valid repository name: use letters, digits, '-', '_' and '.'");
    }
    Ok(())
}

fn check_repo_url(url: &str) -> Result<()> {
    let ok = (url.starts_with("http://") || url.starts_with("https://"))
        && url.len() > "https://".len()
        && !url.chars().any(char::is_whitespace);
    if !ok {
        bail!("{url:?} is not a repository URL: it must start with http:// or https://");
    }
    Ok(())
}

/// A chart reference (`repo/chart`) or version, safe as an argument.
pub(crate) fn check_word(what: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_whitespace) {
        bail!("{value:?} is not a valid {what}");
    }
    Ok(())
}

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// The configured repositories, in helm's order.
pub async fn list_repos() -> Result<Vec<HelmRepo>> {
    let out = match run_helm_with_input(&words(&["repo", "list", "-o", "json"]), None, None).await {
        Ok(out) => out,
        // Older helm fails instead of printing `[]`.
        Err(e) if e.to_string().contains("no repositories to show") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    if out.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&out).context("cannot read the output of helm repo list")
}

/// `helm repo add <name> <url>`; helm downloads the index to check it.
pub async fn add_repo(name: &str, url: &str) -> Result<String> {
    check_repo_name(name)?;
    check_repo_url(url)?;
    run_helm_with_input(&words(&["repo", "add", name, url]), None, None)
        .await
        .map_err(|e| anyhow!("Cannot add repository {name}: {e}"))?;
    Ok(format!("Added repository {name} ({url})"))
}

/// `helm repo remove <name>`.
pub async fn remove_repo(name: &str) -> Result<String> {
    check_repo_name(name)?;
    run_helm_with_input(&words(&["repo", "remove", name]), None, None)
        .await
        .map_err(|e| anyhow!("Cannot remove repository {name}: {e}"))?;
    Ok(format!("Removed repository {name}"))
}

/// `helm repo update [names]` (empty: every repository).
pub async fn update_repos(names: &[String]) -> Result<HelmRepoUpdate> {
    for n in names {
        check_repo_name(n)?;
    }
    let mut args = words(&["repo", "update"]);
    args.extend(names.iter().cloned());
    let out = run_helm_with_input(&args, None, None).await.map_err(|e| {
        let text = e.to_string();
        if text.contains("no repositories found") && !text.contains("matching") {
            anyhow!("No chart repositories are configured: add one first.")
        } else {
            anyhow!("Cannot update repositories: {e}")
        }
    })?;
    Ok(parse_update(&out))
}

/// The repository name in `...<verb> the "<name>" chart repository`.
fn quoted_repo(line: &str) -> Option<&str> {
    let start = line.find('"')? + 1;
    let len = line[start..].find('"')?;
    Some(&line[start..start + len])
}

/// Read helm's progress text: one success or failure line per repository,
/// a failure followed by its indented reason.
fn parse_update(out: &str) -> HelmRepoUpdate {
    let mut result = HelmRepoUpdate::default();
    let mut lines = out.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.starts_with("...Successfully got an update") {
            if let Some(name) = quoted_repo(line) {
                result.updated.push(name.to_string());
            }
        } else if line.starts_with("...Unable to get an update") {
            let name = quoted_repo(line).unwrap_or("?").to_string();
            let mut reason = String::new();
            while let Some(next) = lines.next_if(|l| l.starts_with(char::is_whitespace)) {
                if !reason.is_empty() {
                    reason.push(' ');
                }
                reason.push_str(next.trim());
            }
            result.failed.push(if reason.is_empty() {
                format!("Repository {name} could not be reached.")
            } else {
                format!("Repository {name} could not be reached: {reason}")
            });
        }
    }
    result
}

fn no_repos(e: anyhow::Error) -> anyhow::Error {
    if e.to_string().contains("no repositories configured") {
        anyhow!("No chart repositories are configured: add one first.")
    } else {
        e
    }
}

/// Search the repositories' cached indexes (`helm search repo`): charts
/// whose name or description contains `query` (all charts when empty),
/// the newest version of each, or every version with `all_versions`.
pub async fn search_charts(query: &str, all_versions: bool) -> Result<Vec<HelmChartVersion>> {
    let mut args = words(&["search", "repo", "-o", "json"]);
    if all_versions {
        args.push("--versions".into());
    }
    // `--` so a query that starts with `-` is not taken as a flag.
    args.extend(["--".into(), query.trim().to_string()]);
    let out = run_helm_with_input(&args, None, None)
        .await
        .map_err(no_repos)?;
    parse_search(&out)
}

/// Every version of a chart, newest first. `chart` is `repo/chart` for one
/// repository, or a bare chart name to find it in any repository (where a
/// release's chart came from: a release does not record its repository).
pub async fn chart_versions(chart: &str) -> Result<Vec<HelmChartVersion>> {
    check_word("chart name", chart)?;
    let bare = chart.rsplit('/').next().unwrap_or(chart);
    let found = search_charts(bare, true).await?;
    Ok(found
        .into_iter()
        .filter(|c| matches_chart(&c.name, chart))
        .collect())
}

fn matches_chart(listed: &str, wanted: &str) -> bool {
    if wanted.contains('/') {
        listed == wanted
    } else {
        listed
            .rsplit_once('/')
            .is_some_and(|(_, name)| name == wanted)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ChartYaml {
    version: String,
    app_version: String,
    description: String,
    home: String,
}

fn show_args(what: &str, chart: &str, version: &str) -> Vec<String> {
    let mut args = words(&["show", what, chart]);
    if !version.is_empty() {
        args.extend(["--version".into(), version.to_string()]);
    }
    args
}

/// A chart version's metadata, README and default values (`helm show`),
/// fetched one after another. `version` empty means the newest.
pub async fn chart_details(chart: &str, version: &str) -> Result<HelmChartDetails> {
    check_word("chart name", chart)?;
    if !version.is_empty() {
        check_word("chart version", version)?;
    }
    let (meta_args, readme_args, values_args) = (
        show_args("chart", chart, version),
        show_args("readme", chart, version),
        show_args("values", chart, version),
    );
    // One after another: each `helm show` downloads the chart into the shared
    // repository cache and renames its temp file over the cached one; on
    // Windows that rename fails ("Access denied") while another helm process
    // has the file open (#157). Stop at the first failure.
    let fail = |e: anyhow::Error| anyhow!("Cannot show chart {chart}: {e}");
    let meta = run_helm_with_input(&meta_args, None, None)
        .await
        .map_err(fail)?;
    let meta: ChartYaml = serde_yaml::from_str(&meta)
        .with_context(|| format!("cannot read the Chart.yaml of {chart}"))?;
    let mut values = run_helm_with_input(&values_args, None, None)
        .await
        .map_err(fail)?;
    if !values.is_empty() {
        values.push('\n');
    }
    let readme = run_helm_with_input(&readme_args, None, None)
        .await
        .map_err(fail)?;
    Ok(HelmChartDetails {
        chart: chart.to_string(),
        version: meta.version,
        app_version: meta.app_version,
        description: meta.description,
        home: meta.home,
        readme,
        values,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_helm_repo_update() {
        let out = "Hang tight while we grab the latest from your chart repositories...
...Unable to get an update from the \"bad\" chart repository (http://127.0.0.1:1):
\tGet \"http://127.0.0.1:1/index.yaml\": dial tcp 127.0.0.1:1: connect: connection refused
...Successfully got an update from the \"local\" chart repository
Update Complete. ⎈Happy Helming!⎈";
        let r = parse_update(out);
        assert_eq!(r.updated, ["local"]);
        assert_eq!(
            r.failed,
            ["Repository bad could not be reached: Get \"http://127.0.0.1:1/index.yaml\": dial tcp 127.0.0.1:1: connect: connection refused"]
        );
    }

    #[test]
    fn checks_names_and_urls() {
        for ok in ["bitnami", "my-repo", "a.b_c", "0"] {
            assert!(check_repo_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-x", "a/b", "a b", "--help"] {
            assert!(check_repo_name(bad).is_err(), "{bad}");
        }
        assert!(check_repo_url("https://charts.example.com/x").is_ok());
        assert!(check_repo_url("http://127.0.0.1:8080").is_ok());
        for bad in [
            "",
            "ftp://x",
            "https://",
            "https://a b",
            "--insecure",
            "oci://r",
        ] {
            assert!(check_repo_url(bad).is_err(), "{bad}");
        }
        assert!(check_word("chart name", "repo/chart").is_ok());
        assert!(check_word("chart name", "-f").is_err());
        assert!(check_word("chart version", "1.0 2").is_err());
    }

    #[test]
    fn matches_charts_by_full_or_bare_name() {
        assert!(matches_chart("local/demo", "local/demo"));
        assert!(!matches_chart("other/demo", "local/demo"));
        assert!(matches_chart("other/demo", "demo"));
        assert!(!matches_chart("other/demo-x", "demo"));
    }

    #[test]
    fn search_results_tolerate_missing_fields() {
        let v = parse_search(r#"[{"name":"r/c","version":"1.0.0"}]"#).unwrap();
        assert_eq!(v[0].app_version, "");
        assert_eq!(v[0].description, "");
    }

    #[tokio::test]
    async fn rejects_bad_input_before_running_helm() {
        assert!(add_repo("ok", "file:///etc").await.is_err());
        assert!(add_repo("-x", "https://a.example").await.is_err());
        assert!(remove_repo("").await.is_err());
        assert!(chart_details("-x", "").await.is_err());
        assert!(chart_details("r/c", "--devel").await.is_err());
    }
}
