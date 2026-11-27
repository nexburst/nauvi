//! `nauvi link` (#548).
//!
//! `nauvi link <kind>/<name>` prints the object's `nauvi://` link, built
//! by the same code as the app's "Copy link" ([`links::object_link`]). The
//! nauvi skill tells an AI CLI to print it after every object it names; in
//! the app's Ask AI terminal the link opens the object when clicked.

use crate::get::{object_namespace, resolve_kind_named, split_target};
use crate::links::{self, ObjectLink};
use anyhow::{Context, Result};
use kube::config::Kubeconfig;
use kube::Client;
use std::path::Path;

/// What `nauvi link` is asked about.
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

/// What the arguments point at: one object.
async fn target(client: &Client, a: &LinkArgs<'_>) -> Result<ObjectLink> {
    let (kind, name) = split_target(a.target, a.name)?;
    let Some(name) = name else {
        anyhow::bail!("link needs <kind>/<name> or <kind> <name>");
    };
    let kind = resolve_kind_named(client, kind).await?;
    let context = kube_context(a.kubeconfig, a.context)?;
    // Outside an Ask AI terminal nothing in the environment is about links.
    let context = match a.kubeconfig {
        Some(_) => context,
        None => links::link_context(&context, |k| std::env::var(k).ok()),
    };
    let namespace = object_namespace(client, &kind.resource, a.namespace);
    Ok(links::object_ref(
        &context,
        &kind.resource,
        &namespace,
        name,
    ))
}

/// `nauvi link`: the object's link.
pub async fn print_link(client: &Client, a: &LinkArgs<'_>) -> Result<()> {
    let link = target(client, a).await?;
    println!("{}", link.to_url().map_err(link_error)?);
    Ok(())
}

fn link_error(e: String) -> anyhow::Error {
    anyhow::anyhow!("This object can't be linked to: {e}.")
}

#[cfg(test)]
mod tests {
    use super::*;

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
