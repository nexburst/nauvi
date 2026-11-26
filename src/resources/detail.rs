//! The detail panel for any kind: metadata, owners, conditions, events,
//! and for pods the pod section ([`super::pod_detail`]).

use super::columns::age_text;
use super::jsonpath::{array_at, first_of, path_str};
use super::mask_json::mask_json;
use super::ops::is_secret;
use super::pod_detail::pod_extras;
use super::secret_copy::{secret_copy_keys, LAST_APPLIED};
use super::*;
use crate::{age_of_secs, created_secs};
use anyhow::Result;
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, DynamicObject, ListParams};
use kube::Client;
use serde_json::Value;

/// Metadata, owners, conditions and related events for the detail panel.
pub async fn get_resource_detail(
    client: &Client,
    r: &ResourceRef,
    namespace: &str,
    name: &str,
) -> Result<ResourceDetail> {
    let obj = get_resource(client, r, namespace, name).await?;
    let uid = obj.metadata.uid.clone().unwrap_or_default();
    let events = related_events(client, namespace, &uid).await;
    detail_of(r, &obj, events)
}

/// The detail of `obj` (of kind `r`) with its related `events` already
/// summarized ([`summarize_events`]).
pub fn detail_of(
    r: &ResourceRef,
    obj: &DynamicObject,
    events: Vec<RelatedEvent>,
) -> Result<ResourceDetail> {
    let mut value = serde_json::to_value(obj)?;
    let meta = &obj.metadata;
    let uid = meta.uid.clone().unwrap_or_default();
    let created = created_secs(&meta.creation_timestamp);

    let mut annotations = meta.annotations.clone().unwrap_or_default();
    if is_secret(r) {
        // last-applied, kapp's original and the like repeat the Secret's
        // values: hidden like the values themselves.
        for k in secret_copy_keys(&value) {
            annotations.insert(k, REDACTED.into());
        }
    } else if let Some(a) = annotations.get_mut(LAST_APPLIED) {
        // It repeats the whole object: a pod's args and env. The panel gets
        // it masked; the YAML tab shows it as stored.
        *a = mask_json(a).0;
    }
    let owners = meta
        .owner_references
        .iter()
        .flatten()
        .map(|o| OwnerLink {
            api_version: o.api_version.clone(),
            kind: o.kind.clone(),
            name: o.name.clone(),
            controller: o.controller.unwrap_or(false),
        })
        .collect();
    let conditions = array_at(&value, "/status/conditions")
        .filter(|c| c.get("type").is_some())
        .map(|c| {
            let when = first_of(&[
                path_str(c, ".lastTransitionTime"),
                path_str(c, ".lastUpdateTime"),
            ]);
            ConditionInfo {
                type_: path_str(c, ".type"),
                status: path_str(c, ".status"),
                reason: path_str(c, ".reason"),
                message: path_str(c, ".message"),
                age: if when.is_empty() {
                    when
                } else {
                    age_text(&when)
                },
            }
        })
        .collect();
    let secret_keys = if is_secret(r) {
        value
            .pointer("/data")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| SecretKey {
                        key: k.clone(),
                        // Decoded size of the base64 value.
                        bytes: (v.as_str().unwrap_or("").trim_end_matches('=').len() * 3 / 4)
                            as u32,
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let pod = if r.is("", "Pod") {
        // The typed pod needs its identity, which a list item may lack.
        value["apiVersion"] = "v1".into();
        value["kind"] = "Pod".into();
        pod_extras(&serde_json::from_value::<Pod>(value)?)
    } else {
        PodExtras::default()
    };
    Ok(ResourceDetail {
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone().unwrap_or_default(),
        uid,
        api_version: r.api_resource().api_version,
        kind: r.kind.clone(),
        created,
        age: age_of_secs(created),
        labels: meta.labels.clone().unwrap_or_default(),
        annotations,
        finalizers: meta.finalizers.clone().unwrap_or_default(),
        owners,
        conditions,
        secret_keys,
        events,
        pod,
    })
}

/// Events whose involved object has this uid, newest first. Best effort:
/// without permission to read events the panel just shows none.
async fn related_events(client: &Client, namespace: &str, uid: &str) -> Vec<RelatedEvent> {
    if uid.is_empty() {
        return Vec::new();
    }
    let api: Api<Event> = if namespace.is_empty() {
        // Events of cluster-scoped objects are filed in some namespace.
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let Ok(list) = api.list(&lp).await else {
        return Vec::new();
    };
    summarize_events(list.items)
}

/// Events for the panel, newest first, at most 50.
pub fn summarize_events(items: impl IntoIterator<Item = Event>) -> Vec<RelatedEvent> {
    let mut events: Vec<(i64, RelatedEvent)> = items
        .into_iter()
        .map(|e| {
            let ts = e
                .last_timestamp
                .as_ref()
                .map(|t| t.0.as_second())
                .or_else(|| e.event_time.as_ref().map(|t| t.0.as_second()))
                .or_else(|| {
                    e.metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.as_second())
                })
                .unwrap_or(0);
            (
                ts,
                RelatedEvent {
                    type_: e.type_.unwrap_or_default(),
                    reason: e.reason.unwrap_or_default(),
                    message: e.message.unwrap_or_default(),
                    count: i64::from(e.count.unwrap_or(1)),
                    age: age_of_secs(ts),
                    time: ts,
                },
            )
        })
        .collect();
    events.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
    events.into_iter().take(50).map(|(_, e)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::rref;
    use super::*;

    fn with_last_applied(kind: &str, applied: Value) -> DynamicObject {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": kind,
            "metadata": {
                "name": "x",
                "namespace": "demo",
                "annotations": { LAST_APPLIED: applied.to_string(), "team": "a" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn last_applied_reaches_the_panel_masked() {
        let applied = serde_json::json!({
            "kind": "ConfigMap",
            "data": { "password": "hunter2", "mode": "fast" }
        });
        let obj = with_last_applied("ConfigMap", applied);
        let d = detail_of(&rref("", "ConfigMap", "configmaps", true), &obj, vec![]).unwrap();
        let a = &d.annotations[LAST_APPLIED];
        assert!(!a.contains("hunter2"), "the password reached the panel");
        assert!(a.contains("\"mode\":\"fast\""));
        assert_eq!(d.annotations["team"], "a");
    }

    #[test]
    fn a_secrets_last_applied_stays_redacted() {
        let obj = with_last_applied("Secret", serde_json::json!({ "data": { "k": "dg==" } }));
        let d = detail_of(&rref("", "Secret", "secrets", true), &obj, vec![]).unwrap();
        assert_eq!(d.annotations[LAST_APPLIED], REDACTED);
    }

    #[test]
    fn a_secrets_other_copies_are_redacted() {
        let original = serde_json::json!({ "kind": "Secret", "stringData": { "pw": "hunter2" } });
        let obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "x",
                "namespace": "demo",
                "annotations": { "kapp.k14s.io/original": original.to_string(), "team": "a" }
            },
            "data": { "pw": "aHVudGVyMg==" }
        }))
        .unwrap();
        let d = detail_of(&rref("", "Secret", "secrets", true), &obj, vec![]).unwrap();
        assert_eq!(d.annotations["kapp.k14s.io/original"], REDACTED);
        assert_eq!(d.annotations["team"], "a");
    }
}
