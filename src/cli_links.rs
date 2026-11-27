//! `nauvi link` and `nauvi show` (#548).
//!
//! `nauvi link <kind>/<name>` prints the object's `nauvi://` link, built
//! by the same code as the app's "Copy link" ([`links::object_link`]). The
//! nauvi skill tells an AI CLI to print it after every object it names; in
//! the app's Ask AI terminal the link opens the object when clicked.
//!
//! `nauvi show` asks the running app to open the view itself. It only does
//! so from inside an Ask AI terminal whose session was started with
//! "Let Ask AI open views" on: that terminal's environment holds the
//! session's token ([`links::SHOW_SESSION_ENV`]) and the app's own program
//! ([`links::SHOW_APP_ENV`]). The CLI starts that program with
//! [`links::SHOW_FLAG`], the token and the request; the program hands them
//! over to the running app (its single-instance check) and exits. The app
//! checks the token, the setting and a rate limit, and only opens a view.
//! Anywhere else `nauvi show` prints the link instead.

use crate::get::{object_namespace, resolve_kind_named, split_target};
use crate::links::{self, ObjectLink};
use anyhow::{Context, Result};
use kube::config::Kubeconfig;
use kube::Client;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// How long the hand-over to the running app may take.
const HAND_OVER: Duration = Duration::from_secs(20);

/// What `nauvi link` and `nauvi show` are asked about.
pub struct LinkArgs<'a> {
    pub kubeconfig: Option<&'a Path>,
    pub context: Option<&'a str>,
    pub target: &'a str,
    pub name: Option<&'a str>,
    pub namespace: Option<&'a str>,
}

/// The context name the CLI uses: `--context`, else the kubeconfig's
/// current context.
fn kube_context(kubeconfig: Option<&Path>, context: Option<&str>) -> Result<String> {
    if let Some(c) = context {
        return Ok(c.to_string());
    }
    let kc = match kubeconfig {
        Some(path) => Kubeconfig::read_from(path),
        None => Kubeconfig::read(),
    }
    .context("cannot read the kubeconfig")?;
    kc.current_context
        .filter(|c| !c.is_empty())
        .context("the kubeconfig sets no current context; pass --context")
}

/// What the arguments point at: one object, or (`table`, no name) a kind's
/// table with `-n` or no namespace.
async fn target(client: &Client, a: &LinkArgs<'_>, table: bool) -> Result<ObjectLink> {
    let (kind, name) = split_target(a.target, a.name)?;
    if name.is_none() && !table {
        anyhow::bail!("link needs <kind>/<name> or <kind> <name>");
    }
    let kind = resolve_kind_named(client, kind).await?;
    let context = kube_context(a.kubeconfig, a.context)?;
    // Outside an Ask AI terminal nothing in the environment is about links.
    let context = match a.kubeconfig {
        Some(_) => context,
        None => links::link_context(&context, |k| std::env::var(k).ok()),
    };
    let (namespace, name) = match name {
        Some(name) => (object_namespace(client, &kind.resource, a.namespace), name),
        None if kind.resource.namespaced => (a.namespace.unwrap_or("").to_string(), ""),
        None => (String::new(), ""),
    };
    Ok(links::object_ref(
        &context,
        &kind.resource,
        &namespace,
        name,
    ))
}

/// `nauvi link`: the object's link.
pub async fn print_link(client: &Client, a: &LinkArgs<'_>) -> Result<()> {
    let link = target(client, a, false).await?;
    println!("{}", link.to_url().map_err(link_error)?);
    Ok(())
}

fn link_error(e: String) -> anyhow::Error {
    anyhow::anyhow!("This object can't be linked to: {e}.")
}

/// What it is, for a sentence: `Pod demo/web`, `the Pod table in demo`.
fn what(link: &ObjectLink) -> String {
    match (link.is_table(), link.namespace.as_str()) {
        (false, "") => format!("{} {}", link.kind, link.name),
        (false, ns) => format!("{} {ns}/{}", link.kind, link.name),
        (true, "") => format!("the {} table", link.kind),
        (true, ns) => format!("the {} table in {ns}", link.kind),
    }
}

/// `nauvi show`: ask the app to open the view, or print its link.
pub async fn show(client: &Client, a: &LinkArgs<'_>) -> Result<()> {
    let link = target(client, a, true).await?;
    let request = link.to_show_url().map_err(link_error)?;
    let url = if link.is_table() {
        None
    } else {
        Some(link.to_url().map_err(link_error)?)
    };
    let print_instead = |why: &str| {
        println!("{why}");
        if let Some(url) = &url {
            println!("{url}");
        }
    };
    let token = std::env::var(links::SHOW_SESSION_ENV).unwrap_or_default();
    let app = std::env::var_os(links::SHOW_APP_ENV).unwrap_or_default();
    if token.is_empty() || app.is_empty() {
        print_instead(
            "nauvi show opens views only from the Ask AI terminal of the nauvi app, with \
             Settings, AI, \"Let Ask AI open views\" on (then start Ask AI again). \
             Nothing was opened; give the user the link instead:",
        );
        return Ok(());
    }
    match hand_over(Path::new(&app), &token, &request).await {
        Ok(()) => {
            println!(
                "Asked the nauvi app to show {}. If it is not shown, the Ask AI terminal says why.",
                what(&link)
            );
            if let Some(url) = &url {
                println!("{url}");
            }
        }
        Err(e) => print_instead(&format!(
            "Could not reach the nauvi app ({e:#}). Nothing was opened; give the user the link instead:"
        )),
    }
    Ok(())
}

/// Start the app's program with the request: it hands it to the running
/// app and exits (with an error if no app runs).
async fn hand_over(app: &Path, token: &str, request: &str) -> Result<()> {
    let mut child = tokio::process::Command::new(app)
        .arg(links::SHOW_FLAG)
        .arg(token)
        .arg(request)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("cannot start {}", app.display()))?;
    let status = tokio::time::timeout(HAND_OVER, child.wait())
        .await
        .context("it did not answer in time")??;
    anyhow::ensure!(status.success(), "the nauvi app is not running");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(namespace: &str, name: &str) -> ObjectLink {
        ObjectLink {
            context: "kind".into(),
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: namespace.into(),
            name: name.into(),
        }
    }

    #[test]
    fn says_what_it_shows() {
        assert_eq!(what(&link("demo", "web")), "Pod demo/web");
        assert_eq!(what(&link("", "n1")), "Pod n1");
        assert_eq!(what(&link("demo", "")), "the Pod table in demo");
        assert_eq!(what(&link("", "")), "the Pod table");
    }

    #[test]
    fn the_context_comes_from_the_flag_or_the_kubeconfig() {
        assert_eq!(kube_context(None, Some("x")).unwrap(), "x");
        let dir = std::env::temp_dir().join(format!("nauvi-cli-links-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config");
        std::fs::write(
            &file,
            "apiVersion: v1\nkind: Config\ncurrent-context: prod\ncontexts: []\nclusters: []\nusers: []\n",
        )
        .unwrap();
        assert_eq!(kube_context(Some(&file), None).unwrap(), "prod");
        std::fs::write(&file, "apiVersion: v1\nkind: Config\n").unwrap();
        let err = kube_context(Some(&file), None).unwrap_err().to_string();
        assert!(err.contains("--context"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
