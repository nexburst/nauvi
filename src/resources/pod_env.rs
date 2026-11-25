//! A container's environment with its values (#447), loaded on demand when
//! the pod panel's Environment list is opened.
//!
//! - literal `value`s come from the pod spec; one that looks like a secret
//!   (same rules as the command line, [`super::mask`]) is withheld and
//!   `hidden`, read only through [`reveal_pod_env_value`];
//! - `configMapKeyRef` and `envFrom` ConfigMaps are read from the
//!   ConfigMap, each key of an `envFrom` source its own row;
//! - `secretKeyRef` and `envFrom` Secrets give names and where they come
//!   from, never a value: the Secret is read for its keys only, and a value
//!   is revealed one key at a time through `reveal_data_value`;
//! - `fieldRef` is resolved for the pod fields the kubelet fills from the
//!   object (`metadata.name`, `status.podIP`, ...), `resourceFieldRef` is
//!   shown as the reference.
//!
//! A source that is missing or may not be read gives a plain line instead
//! of a value. Errors never carry a value.

use super::mask::mask_args;
use crate::actions::{api_error, describe_error};
use anyhow::{bail, Context as _, Result};
use k8s_openapi::api::core::v1::{ConfigMap, EnvFromSource, EnvVar, Pod, Secret};
use kube::{Api, Client};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// Where a variable's value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum EnvSourceKind {
    Literal,
    ConfigMap,
    Secret,
    Field,
    Resource,
    Unknown,
}

/// One variable of a container, as the container sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EnvValue {
    /// The variable (with the `envFrom` prefix).
    pub name: String,
    pub kind: EnvSourceKind,
    /// The ConfigMap or Secret (empty for other kinds).
    pub object: String,
    /// Its key; the field path of a `field`, the resource of a `resource`.
    pub key: String,
    /// The value: a literal, a ConfigMap value or a resolved field. Empty
    /// when `hidden`, on an `error`, or for a `resource`.
    pub value: String,
    /// The value is withheld: always for a Secret, and for a literal that
    /// looks like a secret. Revealed one at a time on request.
    pub hidden: bool,
    /// Why there is no value ("ConfigMap app-cfg not found", ...).
    pub error: String,
    /// A later variable of the same name wins: this one is not what the
    /// container sees.
    pub overridden: bool,
}

/// One `envFrom` source and the variables it provides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EnvFromGroup {
    /// `configmap` or `secret` (`unknown` for neither).
    pub kind: EnvSourceKind,
    pub object: String,
    pub prefix: String,
    pub optional: bool,
    /// Why the source's keys are unknown; `rows` is then empty.
    pub error: String,
    pub rows: Vec<EnvValue>,
}

/// A container's environment: `envFrom` sources first, then `env`, the
/// order the kubelet applies them in (later wins).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ContainerEnv {
    pub container: String,
    pub from: Vec<EnvFromGroup>,
    pub env: Vec<EnvValue>,
}

/// A ConfigMap or Secret as far as the env needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvSource {
    /// Key -> value; a Secret's values are always `None`.
    Found(BTreeMap<String, Option<String>>),
    NotFound,
    /// Could not be read; the sentence to show.
    Failed(String),
}

type SourceId = (EnvSourceKind, String);

fn kind_text(k: EnvSourceKind) -> &'static str {
    match k {
        EnvSourceKind::ConfigMap => "ConfigMap",
        EnvSourceKind::Secret => "Secret",
        _ => "source",
    }
}

/// The `env` and `envFrom` of the container `name` (init, regular or
/// ephemeral).
fn container_env<'a>(pod: &'a Pod, name: &str) -> Option<(&'a [EnvVar], &'a [EnvFromSource])> {
    let spec = pod.spec.as_ref()?;
    let pick = |e: &'a Option<Vec<EnvVar>>, f: &'a Option<Vec<EnvFromSource>>| {
        (e.as_deref().unwrap_or(&[]), f.as_deref().unwrap_or(&[]))
    };
    if let Some(c) = spec.containers.iter().find(|c| c.name == name) {
        return Some(pick(&c.env, &c.env_from));
    }
    if let Some(c) = spec
        .init_containers
        .iter()
        .flatten()
        .find(|c| c.name == name)
    {
        return Some(pick(&c.env, &c.env_from));
    }
    spec.ephemeral_containers
        .iter()
        .flatten()
        .find(|c| c.name == name)
        .map(|c| pick(&c.env, &c.env_from))
}

fn from_source(f: &EnvFromSource) -> (EnvSourceKind, String, bool) {
    if let Some(s) = &f.secret_ref {
        (
            EnvSourceKind::Secret,
            s.name.clone(),
            s.optional == Some(true),
        )
    } else if let Some(c) = &f.config_map_ref {
        (
            EnvSourceKind::ConfigMap,
            c.name.clone(),
            c.optional == Some(true),
        )
    } else {
        (EnvSourceKind::Unknown, String::new(), false)
    }
}

/// The ConfigMaps and Secrets the container's env reads.
pub fn env_sources(pod: &Pod, container: &str) -> BTreeSet<(EnvSourceKind, String)> {
    let mut out = BTreeSet::new();
    let Some((env, env_from)) = container_env(pod, container) else {
        return out;
    };
    for f in env_from {
        let (kind, name, _) = from_source(f);
        if kind != EnvSourceKind::Unknown {
            out.insert((kind, name));
        }
    }
    for e in env {
        if let Some(v) = &e.value_from {
            if let Some(s) = &v.secret_key_ref {
                out.insert((EnvSourceKind::Secret, s.name.clone()));
            } else if let Some(c) = &v.config_map_key_ref {
                out.insert((EnvSourceKind::ConfigMap, c.name.clone()));
            }
        }
    }
    out
}

/// The value of a `fieldRef` the API object holds, if it is one of those.
pub fn field_value(pod: &Pod, path: &str) -> Option<String> {
    let meta = &pod.metadata;
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();
    let in_map = |prefix: &str, map: Option<&BTreeMap<String, String>>| -> Option<String> {
        let key = path.strip_prefix(prefix)?.strip_suffix("']")?;
        Some(map.and_then(|m| m.get(key)).cloned().unwrap_or_default())
    };
    let ips = |list: Option<Vec<String>>| list.map(|l| l.join(","));
    match path {
        "metadata.name" => meta.name.clone(),
        "metadata.namespace" => meta.namespace.clone(),
        "metadata.uid" => meta.uid.clone(),
        "spec.nodeName" => spec.and_then(|s| s.node_name.clone()),
        "spec.serviceAccountName" => spec.and_then(|s| s.service_account_name.clone()),
        "status.podIP" => status.and_then(|s| s.pod_ip.clone()),
        "status.hostIP" => status.and_then(|s| s.host_ip.clone()),
        "status.podIPs" => ips(status
            .and_then(|s| s.pod_ips.as_ref())
            .map(|l| l.iter().map(|i| i.ip.clone()).collect())),
        "status.hostIPs" => ips(status
            .and_then(|s| s.host_ips.as_ref())
            .map(|l| l.iter().map(|i| i.ip.clone()).collect())),
        _ => in_map("metadata.labels['", meta.labels.as_ref())
            .or_else(|| in_map("metadata.annotations['", meta.annotations.as_ref())),
    }
}

/// Whether `value` of the variable `name` looks like a secret.
fn looks_secret(name: &str, value: &str) -> bool {
    !value.is_empty() && mask_args(&[format!("{name}={value}")]).1
}

/// Show `value` on `r`, or hide it if it looks like a secret.
fn set_value(r: &mut EnvValue, value: String) {
    if looks_secret(&r.name, &value) {
        r.hidden = true;
    } else {
        r.value = value;
    }
}

fn row(name: String, kind: EnvSourceKind, object: String, key: String) -> EnvValue {
    EnvValue {
        name,
        kind,
        object,
        key,
        value: String::new(),
        hidden: false,
        error: String::new(),
        overridden: false,
    }
}

/// The env of `container`, given the ConfigMaps and Secrets it reads
/// (`sources`, by [`env_sources`]; one left out counts as not read).
pub fn resolve_env(
    pod: &Pod,
    container: &str,
    sources: &BTreeMap<(EnvSourceKind, String), EnvSource>,
) -> Result<ContainerEnv> {
    let Some((env, env_from)) = container_env(pod, container) else {
        bail!("the pod has no container {container}");
    };
    let unread = EnvSource::Failed("not read".into());
    let source = |id: SourceId| sources.get(&id).unwrap_or(&unread);

    let mut from: Vec<EnvFromGroup> = env_from
        .iter()
        .map(|f| {
            let (kind, object, optional) = from_source(f);
            let prefix = f.prefix.clone().unwrap_or_default();
            let mut g = EnvFromGroup {
                kind,
                object: object.clone(),
                prefix: prefix.clone(),
                optional,
                error: String::new(),
                rows: Vec::new(),
            };
            if kind == EnvSourceKind::Unknown {
                g.error = "neither a ConfigMap nor a Secret".into();
                return g;
            }
            match source((kind, object.clone())) {
                EnvSource::Found(keys) => {
                    g.rows = keys
                        .iter()
                        .map(|(k, v)| {
                            let mut r =
                                row(format!("{prefix}{k}"), kind, object.clone(), k.clone());
                            match v {
                                Some(v) if kind == EnvSourceKind::ConfigMap => {
                                    set_value(&mut r, v.clone())
                                }
                                _ => r.hidden = kind == EnvSourceKind::Secret,
                            }
                            r
                        })
                        .collect();
                }
                EnvSource::NotFound if optional => {
                    g.error = format!(
                        "{} {object} not found (optional: nothing set)",
                        kind_text(kind)
                    );
                }
                EnvSource::NotFound => g.error = format!("{} {object} not found", kind_text(kind)),
                EnvSource::Failed(why) => g.error = why.clone(),
            }
            g
        })
        .collect();

    let mut rows: Vec<EnvValue> = env
        .iter()
        .map(|e| {
            let Some(v) = &e.value_from else {
                let value = e.value.clone().unwrap_or_default();
                let mut r = row(
                    e.name.clone(),
                    EnvSourceKind::Literal,
                    String::new(),
                    String::new(),
                );
                set_value(&mut r, value);
                return r;
            };
            let keyed = |kind: EnvSourceKind, object: &str, key: &str, optional: bool| {
                let mut r = row(e.name.clone(), kind, object.to_string(), key.to_string());
                let what = kind_text(kind);
                let opt = if optional { " (optional: not set)" } else { "" };
                match source((kind, object.to_string())) {
                    EnvSource::Found(keys) => match keys.get(key) {
                        Some(_) if kind == EnvSourceKind::Secret => r.hidden = true,
                        Some(v) => set_value(&mut r, v.clone().unwrap_or_default()),
                        None => r.error = format!("{what} {object} has no key {key}{opt}"),
                    },
                    EnvSource::NotFound => r.error = format!("{what} {object} not found{opt}"),
                    EnvSource::Failed(why) => r.error = why.clone(),
                }
                r
            };
            if let Some(s) = &v.secret_key_ref {
                keyed(
                    EnvSourceKind::Secret,
                    &s.name,
                    &s.key,
                    s.optional == Some(true),
                )
            } else if let Some(c) = &v.config_map_key_ref {
                keyed(
                    EnvSourceKind::ConfigMap,
                    &c.name,
                    &c.key,
                    c.optional == Some(true),
                )
            } else if let Some(f) = &v.field_ref {
                let mut r = row(
                    e.name.clone(),
                    EnvSourceKind::Field,
                    String::new(),
                    f.field_path.clone(),
                );
                set_value(&mut r, field_value(pod, &f.field_path).unwrap_or_default());
                r
            } else if let Some(res) = &v.resource_field_ref {
                row(
                    e.name.clone(),
                    EnvSourceKind::Resource,
                    String::new(),
                    res.resource.clone(),
                )
            } else {
                row(
                    e.name.clone(),
                    EnvSourceKind::Unknown,
                    String::new(),
                    String::new(),
                )
            }
        })
        .collect();

    // Later wins: env over envFrom, a later envFrom over an earlier one, a
    // later env entry over an earlier one.
    let mut seen: HashSet<String> = HashSet::new();
    for r in rows.iter_mut().rev() {
        r.overridden = !seen.insert(r.name.clone());
    }
    for g in from.iter_mut().rev() {
        for r in g.rows.iter_mut().rev() {
            r.overridden = !seen.insert(r.name.clone());
        }
    }
    Ok(ContainerEnv {
        container: container.to_string(),
        from,
        env: rows,
    })
}

/// The sentence for a ConfigMap or Secret that could not be read.
fn read_error(kind: EnvSourceKind, name: &str, namespace: &str, err: &anyhow::Error) -> EnvSource {
    match api_error(err) {
        Some((404, _)) => EnvSource::NotFound,
        Some((403, _)) => EnvSource::Failed(format!(
            "not allowed to read {} {name} in {namespace}",
            kind_text(kind)
        )),
        _ => EnvSource::Failed(format!(
            "cannot read {} {name}: {}",
            kind_text(kind),
            describe_error(err)
        )),
    }
}

async fn read_source(
    client: &Client,
    namespace: &str,
    kind: EnvSourceKind,
    name: &str,
) -> EnvSource {
    let res: Result<BTreeMap<String, Option<String>>> = match kind {
        EnvSourceKind::ConfigMap => Api::<ConfigMap>::namespaced(client.clone(), namespace)
            .get(name)
            .await
            .map(|c| {
                c.data
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(k, v)| (k, Some(v)))
                    .collect()
            })
            .map_err(Into::into),
        // Only the keys are kept: the values are dropped right here.
        EnvSourceKind::Secret => Api::<Secret>::namespaced(client.clone(), namespace)
            .get(name)
            .await
            .map(|s| {
                s.data
                    .unwrap_or_default()
                    .into_keys()
                    .map(|k| (k, None))
                    .collect()
            })
            .map_err(Into::into),
        _ => return EnvSource::Failed("neither a ConfigMap nor a Secret".into()),
    };
    match res {
        Ok(keys) => EnvSource::Found(keys),
        Err(e) => read_error(kind, name, namespace, &e),
    }
}

async fn get_pod(client: &Client, namespace: &str, pod: &str) -> Result<Pod> {
    Api::<Pod>::namespaced(client.clone(), namespace)
        .get(pod)
        .await
        .with_context(|| format!("cannot read pod {namespace}/{pod}"))
}

/// The env of one container of a pod, with ConfigMap values and without
/// Secret values.
pub async fn get_pod_env(
    client: &Client,
    namespace: &str,
    pod: &str,
    container: &str,
) -> Result<ContainerEnv> {
    let p = get_pod(client, namespace, pod).await?;
    let ids: Vec<SourceId> = env_sources(&p, container).into_iter().collect();
    let read = futures::future::join_all(
        ids.iter()
            .map(|(kind, name)| read_source(client, namespace, *kind, name)),
    )
    .await;
    let sources = ids.into_iter().zip(read).collect();
    resolve_env(&p, container, &sources)
}

/// Where the value of a hidden row is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevealFrom {
    /// In the pod spec (a literal, or a resolved `fieldRef`).
    Value(String),
    /// A key of a ConfigMap.
    ConfigMapKey { name: String, key: String },
}

/// Where the value of one row of [`resolve_env`] is. The row is named by
/// its position, so a variable that appears twice is never confused with
/// the other one: `group` is the index of its `envFrom` source, or `-1` for
/// `env`, where `index` is its position; `name` must still match. Secret
/// values are not revealed here (they go through `reveal_data_value`).
pub fn env_reveal_from(
    pod: &Pod,
    container: &str,
    group: i32,
    index: u32,
    name: &str,
) -> Result<RevealFrom> {
    let Some((env, env_from)) = container_env(pod, container) else {
        bail!("the pod has no container {container}");
    };
    let gone = || anyhow::anyhow!("container {container} has no variable {name} there any more");
    if group >= 0 {
        let f = env_from.get(group as usize).ok_or_else(gone)?;
        let Some(c) = &f.config_map_ref else {
            bail!("{name} comes from a Secret: reveal it from the Secret");
        };
        let key = name
            .strip_prefix(f.prefix.as_deref().unwrap_or(""))
            .ok_or_else(gone)?;
        return Ok(RevealFrom::ConfigMapKey {
            name: c.name.clone(),
            key: key.to_string(),
        });
    }
    let e = env
        .get(index as usize)
        .filter(|e| e.name == name)
        .ok_or_else(gone)?;
    let Some(v) = &e.value_from else {
        return Ok(RevealFrom::Value(e.value.clone().unwrap_or_default()));
    };
    if let Some(f) = &v.field_ref {
        Ok(RevealFrom::Value(
            field_value(pod, &f.field_path).unwrap_or_default(),
        ))
    } else if let Some(c) = &v.config_map_key_ref {
        Ok(RevealFrom::ConfigMapKey {
            name: c.name.clone(),
            key: c.key.clone(),
        })
    } else if v.secret_key_ref.is_some() {
        bail!("{name} comes from a Secret: reveal it from the Secret")
    } else {
        bail!("{name} has no value to reveal")
    }
}

/// Read one value [`resolve_env`] hid because it looks like a secret (the
/// user asked to see it): a literal, a field or a ConfigMap value. The row
/// is named as in [`env_reveal_from`].
pub async fn reveal_pod_env_value(
    client: &Client,
    namespace: &str,
    pod: &str,
    container: &str,
    group: i32,
    index: u32,
    name: &str,
) -> Result<String> {
    let p = get_pod(client, namespace, pod).await?;
    match env_reveal_from(&p, container, group, index, name)? {
        RevealFrom::Value(v) => Ok(v),
        RevealFrom::ConfigMapKey { name: cm, key } => {
            let c = Api::<ConfigMap>::namespaced(client.clone(), namespace)
                .get(&cm)
                .await
                .with_context(|| format!("cannot read ConfigMap {cm}"))?;
            c.data
                .and_then(|mut d| d.remove(&key))
                .with_context(|| format!("ConfigMap {cm} has no key {key} any more"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(v: serde_json::Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    fn cm(pairs: &[(&str, &str)]) -> EnvSource {
        EnvSource::Found(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), Some(v.to_string())))
                .collect(),
        )
    }

    fn secret(keys: &[&str]) -> EnvSource {
        EnvSource::Found(keys.iter().map(|k| (k.to_string(), None)).collect())
    }

    fn sample() -> Pod {
        pod(json!({
            "metadata": { "name": "web-1", "namespace": "shop", "labels": { "app": "web" } },
            "spec": {
                "nodeName": "node-a",
                "containers": [{
                    "name": "app",
                    "envFrom": [
                        { "configMapRef": { "name": "base" }, "prefix": "CFG_" },
                        { "secretRef": { "name": "creds" } },
                        { "configMapRef": { "name": "gone", "optional": true } }
                    ],
                    "env": [
                        { "name": "PLAIN", "value": "hello" },
                        { "name": "DB_PASSWORD", "value": "s3cr3t-literal" },
                        { "name": "DSN", "value": "postgres://u:pw-in-url@db/x" },
                        { "name": "LEVEL", "valueFrom": { "configMapKeyRef": { "name": "base", "key": "level" } } },
                        { "name": "TOKEN", "valueFrom": { "secretKeyRef": { "name": "creds", "key": "token" } } },
                        { "name": "NOKEY", "valueFrom": { "configMapKeyRef": { "name": "base", "key": "nope", "optional": true } } },
                        { "name": "MISSING", "valueFrom": { "configMapKeyRef": { "name": "absent", "key": "k" } } },
                        { "name": "HIDDEN", "valueFrom": { "secretKeyRef": { "name": "locked", "key": "k" } } },
                        { "name": "POD", "valueFrom": { "fieldRef": { "fieldPath": "metadata.name" } } },
                        { "name": "APP", "valueFrom": { "fieldRef": { "fieldPath": "metadata.labels['app']" } } },
                        { "name": "NODE", "valueFrom": { "fieldRef": { "fieldPath": "spec.nodeName" } } },
                        { "name": "CPU", "valueFrom": { "resourceFieldRef": { "resource": "limits.cpu" } } },
                        { "name": "CFG_mode", "value": "override" }
                    ]
                }],
                "initContainers": [{ "name": "init", "env": [{ "name": "A", "value": "1" }] }]
            }
        }))
    }

    fn sources() -> BTreeMap<SourceId, EnvSource> {
        BTreeMap::from([
            (
                (EnvSourceKind::ConfigMap, "base".into()),
                cm(&[("level", "debug"), ("mode", "fast")]),
            ),
            (
                (EnvSourceKind::Secret, "creds".into()),
                secret(&["token", "user"]),
            ),
            (
                (EnvSourceKind::ConfigMap, "gone".into()),
                EnvSource::NotFound,
            ),
            (
                (EnvSourceKind::ConfigMap, "absent".into()),
                EnvSource::NotFound,
            ),
            (
                (EnvSourceKind::Secret, "locked".into()),
                EnvSource::Failed("not allowed to read Secret locked in shop".into()),
            ),
        ])
    }

    #[test]
    fn lists_every_source_once() {
        let found = env_sources(&sample(), "app");
        let ids: Vec<(EnvSourceKind, &str)> = found.iter().map(|(k, n)| (*k, n.as_str())).collect();
        assert_eq!(
            ids,
            [
                (EnvSourceKind::ConfigMap, "absent"),
                (EnvSourceKind::ConfigMap, "base"),
                (EnvSourceKind::ConfigMap, "gone"),
                (EnvSourceKind::Secret, "creds"),
                (EnvSourceKind::Secret, "locked"),
            ]
        );
        assert!(env_sources(&sample(), "nope").is_empty());
    }

    #[test]
    fn resolves_each_kind() {
        let env = resolve_env(&sample(), "app", &sources()).unwrap();
        let by = |n: &str| env.env.iter().find(|r| r.name == n).unwrap().clone();

        assert_eq!(by("PLAIN").value, "hello");
        assert_eq!(by("PLAIN").kind, EnvSourceKind::Literal);
        for n in ["DB_PASSWORD", "DSN"] {
            assert!(by(n).hidden && by(n).value.is_empty(), "{n}");
        }
        let level = by("LEVEL");
        assert_eq!(
            (
                level.object.as_str(),
                level.key.as_str(),
                level.value.as_str()
            ),
            ("base", "level", "debug")
        );
        let token = by("TOKEN");
        assert!(token.hidden && token.value.is_empty() && token.error.is_empty());
        assert_eq!(
            by("NOKEY").error,
            "ConfigMap base has no key nope (optional: not set)"
        );
        assert_eq!(by("MISSING").error, "ConfigMap absent not found");
        assert_eq!(
            by("HIDDEN").error,
            "not allowed to read Secret locked in shop"
        );
        assert!(!by("HIDDEN").hidden);
        assert_eq!(by("POD").value, "web-1");
        assert_eq!(by("APP").value, "web");
        assert_eq!(by("NODE").value, "node-a");
        let cpu = by("CPU");
        assert_eq!(
            (cpu.kind, cpu.key.as_str(), cpu.value.as_str()),
            (EnvSourceKind::Resource, "limits.cpu", "")
        );

        let init = resolve_env(&sample(), "init", &sources()).unwrap();
        assert_eq!(init.env[0].value, "1");
        assert!(resolve_env(&sample(), "nope", &sources()).is_err());
    }

    #[test]
    fn env_from_expands_keys_with_prefix_and_marks_overrides() {
        let env = resolve_env(&sample(), "app", &sources()).unwrap();
        let base = &env.from[0];
        let rows: Vec<(&str, &str, bool)> = base
            .rows
            .iter()
            .map(|r| (r.name.as_str(), r.value.as_str(), r.overridden))
            .collect();
        assert_eq!(
            rows,
            [("CFG_level", "debug", false), ("CFG_mode", "fast", true)]
        );
        assert_eq!(base.prefix, "CFG_");

        let creds = &env.from[1];
        assert_eq!(creds.kind, EnvSourceKind::Secret);
        let names: Vec<&str> = creds.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["token", "user"]);
        assert!(creds.rows.iter().all(|r| r.hidden && r.value.is_empty()));

        let gone = &env.from[2];
        assert!(gone.optional && gone.rows.is_empty());
        assert_eq!(
            gone.error,
            "ConfigMap gone not found (optional: nothing set)"
        );
    }

    #[test]
    fn unread_and_forbidden_sources_say_so() {
        let env = resolve_env(&sample(), "app", &BTreeMap::new()).unwrap();
        assert!(env.from.iter().all(|g| g.error == "not read"));
        let forbidden = BTreeMap::from([(
            (EnvSourceKind::Secret, "creds".to_string()),
            EnvSource::Failed("not allowed to read Secret creds in shop".into()),
        )]);
        let env = resolve_env(&sample(), "app", &forbidden).unwrap();
        assert_eq!(
            env.from[1].error,
            "not allowed to read Secret creds in shop"
        );
        assert!(env.from[1].rows.is_empty());
    }

    #[test]
    fn secret_and_masked_values_never_appear() {
        // Even if a lookup carried a Secret value, it is not shown.
        let mut s = sources();
        s.insert(
            (EnvSourceKind::Secret, "creds".into()),
            cm(&[("token", "tok-from-secret"), ("user", "admin-from-secret")]),
        );
        let env = resolve_env(&sample(), "app", &s).unwrap();
        let text = serde_json::to_string(&env).unwrap();
        for v in [
            "tok-from-secret",
            "admin-from-secret",
            "s3cr3t-literal",
            "pw-in-url",
        ] {
            assert!(!text.contains(v), "{v} in {text}");
        }
    }

    fn value(from: Result<RevealFrom>) -> String {
        match from.unwrap() {
            RevealFrom::Value(v) => v,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reveals_the_row_at_its_position() {
        let p = sample();
        // env indexes: DB_PASSWORD 1, LEVEL 3, TOKEN 4, POD 8.
        assert_eq!(
            value(env_reveal_from(&p, "app", -1, 1, "DB_PASSWORD")),
            "s3cr3t-literal"
        );
        assert_eq!(value(env_reveal_from(&p, "app", -1, 8, "POD")), "web-1");
        assert_eq!(
            env_reveal_from(&p, "app", -1, 3, "LEVEL").unwrap(),
            RevealFrom::ConfigMapKey {
                name: "base".into(),
                key: "level".into()
            }
        );
        assert_eq!(
            env_reveal_from(&p, "app", 0, 0, "CFG_mode").unwrap(),
            RevealFrom::ConfigMapKey {
                name: "base".into(),
                key: "mode".into()
            }
        );
        let e = env_reveal_from(&p, "app", -1, 4, "TOKEN")
            .unwrap_err()
            .to_string();
        assert!(e.contains("from the Secret"), "{e}");
        let e = env_reveal_from(&p, "app", 1, 0, "token")
            .unwrap_err()
            .to_string();
        assert!(e.contains("from the Secret"), "{e}");
        // A name that is not at that position any more.
        assert!(env_reveal_from(&p, "app", -1, 2, "DB_PASSWORD").is_err());
        assert!(env_reveal_from(&p, "app", -1, 99, "DB_PASSWORD").is_err());
        assert!(env_reveal_from(&p, "app", 9, 0, "CFG_mode").is_err());
        assert!(env_reveal_from(&p, "nope", -1, 0, "A").is_err());
    }

    #[test]
    fn a_duplicated_name_reveals_the_row_asked_for() {
        let p = pod(json!({ "spec": { "containers": [{ "name": "app", "env": [
            { "name": "API_TOKEN", "value": "first-token" },
            { "name": "API_TOKEN", "value": "second-token" }
        ] }] } }));
        let env = resolve_env(&p, "app", &BTreeMap::new()).unwrap();
        assert!(env.env[0].hidden && env.env[0].overridden);
        assert!(env.env[1].hidden && !env.env[1].overridden);
        assert_eq!(
            value(env_reveal_from(&p, "app", -1, 0, "API_TOKEN")),
            "first-token"
        );
        assert_eq!(
            value(env_reveal_from(&p, "app", -1, 1, "API_TOKEN")),
            "second-token"
        );
    }

    #[test]
    fn config_map_values_that_look_secret_are_hidden() {
        let p = pod(json!({ "spec": { "containers": [{ "name": "app",
            "envFrom": [{ "configMapRef": { "name": "cfg" } }],
            "env": [{ "name": "DB_PASSWORD", "valueFrom": { "configMapKeyRef": { "name": "cfg", "key": "mode" } } }]
        }] } }));
        let s = BTreeMap::from([(
            (EnvSourceKind::ConfigMap, "cfg".to_string()),
            cm(&[
                ("mode", "cm-pw-value"),
                ("API_KEY", "cm-key-value"),
                ("level", "debug"),
            ]),
        )]);
        let env = resolve_env(&p, "app", &s).unwrap();
        // The variable's name says secret: hidden, whatever the key is called.
        assert!(env.env[0].hidden && env.env[0].value.is_empty());
        // Through envFrom the variable is named after the key: `mode` is not
        // a secret-looking name, `API_KEY` is.
        let rows: Vec<(&str, bool, &str)> = env.from[0]
            .rows
            .iter()
            .map(|r| (r.name.as_str(), r.hidden, r.value.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("API_KEY", true, ""),
                ("level", false, "debug"),
                ("mode", false, "cm-pw-value")
            ]
        );
        let text = serde_json::to_string(&env).unwrap();
        assert!(!text.contains("cm-key-value"), "{text}");
    }
}
