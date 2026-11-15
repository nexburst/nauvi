//! Helm chart repositories, search, install and upgrade against the kind
//! cluster, with a chart repository served from a temporary directory on
//! 127.0.0.1 (no internet). `#[ignore]`d; run with
//! `cargo test --test helm_charts_cluster -- --ignored`.
//!
//! The test points helm at temporary configuration, cache and data
//! directories (`HELM_CONFIG_HOME`, ...), so it never sees or changes the
//! developer's own repositories. Like `helm_cluster.rs`, it needs `helm` and
//! skips without it, except in CI.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, DeleteParams};
use kube::Client;
use kubeloupe::client_for_context;
use kubeloupe::helm::{
    add_repo, chart_details, chart_versions, get_helm_release, helm_install, helm_uninstall,
    helm_upgrade, helm_version, list_helm_releases, list_repos, remove_repo, search_charts,
    update_repos, HelmDeployRequest, HelmRepo, HelmTarget,
};
use kubeloupe::resources::REDACTED;

fn context() -> String {
    std::env::var("KUBELOUPE_TEST_CONTEXT").unwrap_or_else(|_| "kind-kubeloupe-test".to_string())
}

fn helm_bin() -> String {
    std::env::var("KUBELOUPE_HELM")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "helm".into())
}

const CHART: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/scripts/test-cluster/charts/demo-chart"
);

async fn have_helm() -> Result<bool> {
    match helm_version().await {
        Ok(_) => Ok(true),
        Err(e) if std::env::var_os("CI").is_some() => bail!("helm is required in CI: {e:#}"),
        Err(e) => {
            eprintln!("skipping: {e:#}");
            Ok(false)
        }
    }
}

/// A fresh temporary directory.
fn temp_dir(what: &str) -> Result<PathBuf> {
    let suffix = std::process::id() ^ chrono::Utc::now().timestamp_subsec_micros();
    let dir = std::env::temp_dir().join(format!("kubeloupe-{what}-{suffix:x}"));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Point helm (this process's children) at empty temporary homes. This test
/// binary has one test, so nothing else reads the environment meanwhile.
fn isolate_helm(home: &Path) -> Result<()> {
    for (var, sub) in [
        ("HELM_CONFIG_HOME", "config"),
        ("HELM_CACHE_HOME", "cache"),
        ("HELM_DATA_HOME", "data"),
    ] {
        let dir = home.join(sub);
        std::fs::create_dir_all(&dir)?;
        std::env::set_var(var, &dir);
    }
    std::env::remove_var("HELM_REPOSITORY_CONFIG");
    std::env::remove_var("HELM_REPOSITORY_CACHE");
    Ok(())
}

/// `demo-chart` packaged as 0.1.0 and 0.2.0, with an `index.yaml`.
fn build_repo(dir: &Path, url: &str) -> Result<()> {
    for version in ["0.1.0", "0.2.0"] {
        let out = Command::new(helm_bin())
            .args(["package", CHART, "--version", version, "-d"])
            .arg(dir)
            .output()
            .context("cannot run helm package")?;
        ensure!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let out = Command::new(helm_bin())
        .args(["repo", "index"])
        .arg(dir)
        .args(["--url", url])
        .output()?;
    ensure!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

/// A static file server on 127.0.0.1, one connection at a time, until
/// `stop` is set.
struct RepoServer {
    url: String,
    stop: Arc<AtomicBool>,
    addr: std::net::SocketAddr,
}

impl RepoServer {
    fn start(dir: PathBuf) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(conn) = conn {
                    let _ = serve(conn, &dir);
                }
            }
        });
        Ok(Self {
            url: format!("http://{addr}"),
            stop,
            addr,
        })
    }

    /// Stop accepting connections, so the repository is unreachable.
    fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop so it sees the flag and drops the listener.
        let _ = TcpStream::connect(self.addr);
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn serve(mut conn: TcpStream, dir: &Path) -> Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    // Skip the headers.
    let mut line = String::new();
    while reader.read_line(&mut line)? > 2 {
        line.clear();
    }
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let name = path.trim_start_matches('/');
    let file = (!name.contains("..") && !name.contains('/'))
        .then(|| std::fs::read(dir.join(name)).ok())
        .flatten();
    match file {
        Some(body) => {
            write!(
                conn,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            conn.write_all(&body)?;
        }
        None => write!(
            conn,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?,
    }
    Ok(())
}

async fn client() -> Result<Client> {
    tokio::time::timeout(
        Duration::from_secs(20),
        client_for_context(Some(&context())),
    )
    .await
    .context("timed out building client")?
}

#[tokio::test]
#[ignore]
async fn helm_repos_search_install_and_upgrade_with_values() -> Result<()> {
    let home = temp_dir("helm-home")?;
    isolate_helm(&home)?;
    if !have_helm().await? {
        return Ok(());
    }
    let repo_dir = temp_dir("helm-repo")?;
    let server = RepoServer::start(repo_dir.clone())?;
    build_repo(&repo_dir, &server.url)?;

    let client = client().await?;
    let suffix = std::process::id() ^ chrono::Utc::now().timestamp_subsec_micros();
    // Created by helm (`--create-namespace`), deleted below.
    let ns = format!("kl-it-charts-{suffix:x}");
    let result = tokio::time::timeout(Duration::from_secs(240), body(&client, &server, &ns))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    let _ = namespaces
        .delete(&format!("{ns}-x"), &DeleteParams::background())
        .await;
    server.stop();
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&repo_dir);
    result
}

async fn body(client: &Client, server: &RepoServer, ns: &str) -> Result<()> {
    // No repositories yet: an empty list, and a plain search error.
    ensure!(list_repos().await?.is_empty());
    let e = search_charts("demo", false).await.unwrap_err();
    ensure!(
        e.to_string() == "No chart repositories are configured: add one first.",
        "{e}"
    );

    // Add: helm downloads the index; an unreachable URL is refused.
    let msg = add_repo("kl-local", &server.url).await?;
    ensure!(msg.starts_with("Added repository kl-local"), "{msg}");
    let e = add_repo("kl-bad", "http://127.0.0.1:1").await.unwrap_err();
    ensure!(
        e.to_string().starts_with("Cannot add repository kl-bad:")
            && e.to_string().contains("cannot be reached"),
        "{e}"
    );
    ensure!(
        list_repos().await?
            == [HelmRepo {
                name: "kl-local".into(),
                url: server.url.clone()
            }]
    );

    // Search: the newest version, or all of them.
    let found = search_charts("demo", false).await?;
    ensure!(found.len() == 1, "{found:?}");
    ensure!(
        found[0].name == "kl-local/demo-chart"
            && found[0].version == "0.2.0"
            && found[0].app_version == "1.36",
        "{found:?}"
    );
    ensure!(search_charts("no-such-chart-anywhere", false)
        .await?
        .is_empty());
    let versions: Vec<String> = chart_versions("demo-chart")
        .await?
        .into_iter()
        .map(|c| c.version)
        .collect();
    ensure!(versions == ["0.2.0", "0.1.0"], "{versions:?}");
    ensure!(chart_versions("kl-local/demo-chart").await?.len() == 2);
    ensure!(chart_versions("other/demo-chart").await?.is_empty());

    // Details of one version: Chart.yaml, README and default values.
    let d = chart_details("kl-local/demo-chart", "0.1.0").await?;
    ensure!(d.version == "0.1.0" && d.app_version == "1.36", "{d:?}");
    ensure!(d.description.contains("tiny local chart"), "{d:?}");
    ensure!(d.readme.starts_with("# demo-chart"), "{}", d.readme);
    ensure!(
        d.values.contains("greeting: hello") && d.values.ends_with('\n'),
        "{}",
        d.values
    );
    let newest = chart_details("kl-local/demo-chart", "").await?;
    ensure!(newest.version == "0.2.0", "{newest:?}");
    let e = chart_details("kl-local/demo-chart", "9.9.9")
        .await
        .unwrap_err();
    ensure!(e.to_string().starts_with("Cannot show chart"), "{e}");

    let target = HelmTarget {
        kubeconfig: None,
        context: Some(context()),
    };
    let rel = "kl-chart";
    let install = HelmDeployRequest {
        name: rel.into(),
        namespace: ns.into(),
        chart: "kl-local/demo-chart".into(),
        version: "0.1.0".into(),
        values: "greeting: hi\n".into(),
        create_namespace: true,
        dry_run: true,
        reveal: false,
    };

    // A dry run renders with the values and changes nothing.
    let dry = helm_install(&target, &install).await?;
    ensure!(
        dry.dry_run && dry.status == "pending-install" && dry.revision == 1,
        "{dry:?}"
    );
    ensure!(dry.chart_version == "0.1.0", "{dry:?}");
    ensure!(dry.notes.trim() == "kl-chart says hi.", "{}", dry.notes);
    ensure!(
        dry.manifest.contains("greeting: \"hi\""),
        "{}",
        dry.manifest
    );
    ensure!(dry.secrets_hidden && dry.manifest.contains(REDACTED));
    ensure!(!dry.manifest.contains("not-a-real-secret"));
    ensure!(dry.resources.len() == 3, "{:?}", dry.resources);
    ensure!(dry.summary.contains("nothing changed"), "{}", dry.summary);
    ensure!(Api::<Namespace>::all(client.clone())
        .get_opt(ns)
        .await?
        .is_none());

    // The install, into a namespace helm creates.
    let done = helm_install(
        &target,
        &HelmDeployRequest {
            dry_run: false,
            ..install.clone()
        },
    )
    .await?;
    ensure!(
        done.status == "deployed" && done.revision == 1 && !done.dry_run,
        "{done:?}"
    );
    ensure!(
        done.summary == format!("Installed {ns}/{rel} (revision 1)"),
        "{}",
        done.summary
    );
    let r = get_helm_release(client, ns, rel, None, false).await?;
    ensure!(r.values == "greeting: hi\n", "{}", r.values);
    let e = helm_install(
        &target,
        &HelmDeployRequest {
            dry_run: false,
            ..install.clone()
        },
    )
    .await
    .unwrap_err();
    ensure!(
        e.to_string()
            .starts_with("Install of kl-chart failed: cannot re-use a name"),
        "{e}"
    );
    // Without --create-namespace, a missing namespace is an error.
    let e = helm_install(
        &target,
        &HelmDeployRequest {
            namespace: format!("{ns}-x"),
            create_namespace: false,
            dry_run: false,
            ..install.clone()
        },
    )
    .await
    .unwrap_err();
    ensure!(e.to_string().contains("not found"), "{e}");

    // Upgrade dry run: a new version with new values, nothing changed yet.
    let upgrade = HelmDeployRequest {
        version: "0.2.0".into(),
        values: "greeting: bye\nreplicas: 0\n".into(),
        create_namespace: false,
        dry_run: true,
        ..install.clone()
    };
    let dry = helm_upgrade(&target, &upgrade).await?;
    ensure!(
        dry.status == "pending-upgrade" && dry.revision == 2,
        "{dry:?}"
    );
    ensure!(
        dry.manifest.contains("greeting: \"bye\"") && dry.manifest.contains("replicas: 0"),
        "{}",
        dry.manifest
    );
    let current = get_helm_release(client, ns, rel, None, false).await?;
    ensure!(
        current.revision == 1 && current.chart_version == "0.1.0",
        "{current:?}"
    );
    // The diff the app shows: same redaction on both sides.
    ensure!(current.manifest.contains("greeting: \"hi\""));
    ensure!(current.manifest.contains(REDACTED) && dry.manifest.contains(REDACTED));

    // The upgrade: the edited values replace the old ones.
    let up = helm_upgrade(
        &target,
        &HelmDeployRequest {
            dry_run: false,
            ..upgrade.clone()
        },
    )
    .await?;
    ensure!(
        up.summary == format!("Upgraded {ns}/{rel} to revision 2"),
        "{}",
        up.summary
    );
    let r = get_helm_release(client, ns, rel, None, false).await?;
    ensure!(
        r.revision == 2 && r.status == "deployed" && r.chart_version == "0.2.0",
        "{r:?}"
    );
    ensure!(r.values == "greeting: bye\nreplicas: 0\n", "{}", r.values);
    let list = list_helm_releases(client, &[ns.to_string()]).await?;
    ensure!(list.releases.len() == 1 && list.releases[0].revision == 2);

    let e = helm_upgrade(
        &target,
        &HelmDeployRequest {
            values: "greeting: [\n".into(),
            ..upgrade.clone()
        },
    )
    .await
    .unwrap_err();
    ensure!(
        e.to_string().starts_with("The values are not valid YAML"),
        "{e}"
    );
    let e = helm_upgrade(
        &target,
        &HelmDeployRequest {
            name: "kl-none".into(),
            ..upgrade.clone()
        },
    )
    .await
    .unwrap_err();
    ensure!(
        e.to_string()
            .starts_with("Dry run of the upgrade of kl-none failed:")
            && e.to_string().contains("has no deployed releases"),
        "{e}"
    );

    // Update: fine while served, a plain failure once the server is gone.
    let u = update_repos(&[]).await?;
    ensure!(u.updated == ["kl-local"] && u.failed.is_empty(), "{u:?}");
    server.stop();
    let u = update_repos(&["kl-local".to_string()]).await?;
    ensure!(u.updated.is_empty(), "{u:?}");
    ensure!(
        u.failed.len() == 1 && u.failed[0].starts_with("Repository kl-local could not be reached:"),
        "{u:?}"
    );

    // Remove.
    ensure!(remove_repo("kl-local").await? == "Removed repository kl-local");
    ensure!(list_repos().await?.is_empty());
    let e = remove_repo("kl-local").await.unwrap_err();
    ensure!(
        e.to_string()
            .starts_with("Cannot remove repository kl-local:"),
        "{e}"
    );

    helm_uninstall(&target, ns, rel).await?;
    Ok(())
}
