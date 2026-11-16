//! The tools that change the cluster: scale, restart, delete and apply.
//! The server offers them only with `--allow-writes`. They act as the
//! kubeconfig's user, so the API server's RBAC decides what they may do;
//! a refusal comes back as a plain sentence.

use super::limits;
use crate::actions::{describe_error, run_action, ActionId};
use crate::resources::{self, ApplyStatus, ManifestOptions};
use crate::{object_namespace, resolve_kind_named, split_target};
use anyhow::{anyhow, bail, Result};
use kube::Client;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionArgs {
    pub kind: String,
    pub name: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScaleArgs {
    pub kind: String,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub replicas: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyArgs {
    /// One or more YAML documents.
    pub manifest: String,
    /// For objects that name no namespace (default: the context's).
    pub namespace: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// Run one action on one named object.
async fn act(
    client: &Client,
    kind: &str,
    name: Option<&str>,
    namespace: Option<&str>,
    action: ActionId,
    replicas: Option<i32>,
) -> Result<String> {
    let (kind, name) = match split_target(kind, name)? {
        (kind, Some(name)) => (kind, name),
        (_, None) => bail!("give the object's name (`name`, or `kind` as <kind>/<name>)"),
    };
    let kind = resolve_kind_named(client, kind).await?;
    let ns = object_namespace(client, &kind.resource, namespace);
    run_action(client, &kind.resource, &ns, name, action, replicas)
        .await
        .map_err(|e| anyhow!(describe_error(&e)))
}

pub async fn scale(client: &Client, a: &ScaleArgs) -> Result<String> {
    if a.replicas < 0 {
        bail!("replicas must be 0 or more");
    }
    let ns = a.namespace.as_deref();
    act(
        client,
        &a.kind,
        a.name.as_deref(),
        ns,
        ActionId::Scale,
        Some(a.replicas),
    )
    .await
}

pub async fn restart(client: &Client, a: &ActionArgs) -> Result<String> {
    let ns = a.namespace.as_deref();
    act(
        client,
        &a.kind,
        a.name.as_deref(),
        ns,
        ActionId::Restart,
        None,
    )
    .await
}

pub async fn delete(client: &Client, a: &ActionArgs) -> Result<String> {
    let ns = a.namespace.as_deref();
    act(
        client,
        &a.kind,
        a.name.as_deref(),
        ns,
        ActionId::Delete,
        None,
    )
    .await
}

/// Server-side apply of a manifest, a line per object like `kubectl apply`.
/// Nothing is applied unless every object passes a dry run first.
pub async fn apply(client: &Client, a: &ApplyArgs) -> Result<String> {
    if a.manifest.len() > limits::MAX_MANIFEST_BYTES {
        bail!(
            "the manifest is {} KiB; at most {} KiB per call",
            a.manifest.len() / 1024,
            limits::MAX_MANIFEST_BYTES / 1024
        );
    }
    let kinds = resources::discover(client).await?;
    let ns = a
        .namespace
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| client.default_namespace().to_string());
    let opts = ManifestOptions {
        dry_run: a.dry_run,
        skip_invalid: false,
    };
    let results = resources::apply_manifests(client, &kinds, &a.manifest, &ns, opts).await;
    if results.is_empty() {
        bail!("the manifest has no objects");
    }
    let mut text: String = results
        .iter()
        .map(|r| resources::result_line(r, a.dry_run) + "\n")
        .collect();
    let failed = results
        .iter()
        .filter(|r| r.status == ApplyStatus::Failed)
        .count();
    if failed > 0 {
        text.push_str(&format!("{failed} of {} objects failed.\n", results.len()));
        bail!(text);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_args_are_strict() {
        let s: ScaleArgs =
            serde_json::from_value(json!({ "kind": "deploy/web", "replicas": 2 })).unwrap();
        assert_eq!(s.replicas, 2);
        assert!(serde_json::from_value::<ScaleArgs>(json!({ "kind": "deploy/web" })).is_err());
        assert!(
            serde_json::from_value::<ActionArgs>(json!({ "kind": "pod/x", "force": true }))
                .is_err()
        );
        let a: ApplyArgs = serde_json::from_value(json!({ "manifest": "kind: X" })).unwrap();
        assert!(!a.dry_run);
    }
}
