//! What the MCP server never hands to a model: Secret values (it shows
//! their keys only, as #278 does) and the `last-applied-configuration`
//! annotation, which repeats the whole object as `kubectl apply` saw it
//! (for a Secret, its values in clear), and on a Secret any other
//! annotation that copies it ([`resources::secret_copy_keys`]: kapp's
//! `kapp.k14s.io/original` and the like).
//!
//! There is no `reveal` here: unlike the CLI and the app, the server has
//! no way to ask the person at the keyboard.

use crate::resources::{self, ResourceRef};
use anyhow::Result;
use kube::api::DynamicObject;
use serde_json::Value;
use std::collections::BTreeMap;

/// What a redacted value is replaced with.
pub const REDACTED: &str = "<redacted>";

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// `obj` as JSON for a model: without `managedFields`, with `apiVersion`
/// and `kind`, Secret values and the last-applied annotation redacted.
pub fn safe_value(r: &ResourceRef, obj: DynamicObject) -> Result<Value> {
    let mut v = resources::object_value(r, obj, false)?;
    redact_value(&mut v);
    Ok(v)
}

/// Redact Secret values (by `kind`, so it also holds for a Secret inside a
/// `List`) and the last-applied annotation of any object.
pub fn redact_value(v: &mut Value) {
    if let Some(items) = v.get_mut("items").and_then(Value::as_array_mut) {
        items.iter_mut().for_each(redact_value);
    }
    if v.get("kind").and_then(Value::as_str) == Some("Secret") {
        // Before the values go: they are how a copy is recognised.
        let copies = resources::secret_copy_keys(v);
        if let Some(a) = v
            .pointer_mut("/metadata/annotations")
            .and_then(Value::as_object_mut)
        {
            for k in copies {
                a.insert(k, Value::String(REDACTED.into()));
            }
        }
        for field in ["data", "stringData"] {
            if let Some(map) = v.get_mut(field).and_then(Value::as_object_mut) {
                for val in map.values_mut() {
                    *val = Value::String(REDACTED.into());
                }
            }
        }
    }
    if let Some(a) = v
        .pointer_mut("/metadata/annotations")
        .and_then(Value::as_object_mut)
        .and_then(|a| a.get_mut(LAST_APPLIED))
    {
        *a = Value::String(REDACTED.into());
    }
}

/// Annotations (of a describe) with the last-applied one redacted, for any
/// kind (the detail carries Secret keys and sizes, never their values).
pub fn redact_annotations(annotations: &mut BTreeMap<String, String>) {
    if let Some(a) = annotations.get_mut(LAST_APPLIED) {
        *a = REDACTED.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rref(kind: &str, plural: &str) -> ResourceRef {
        ResourceRef {
            group: String::new(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced: true,
        }
    }

    fn obj(v: Value) -> DynamicObject {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn secret_values_are_replaced_and_keys_kept() {
        let secret = obj(json!({
            "metadata": {
                "name": "creds",
                "namespace": "demo",
                "annotations": { LAST_APPLIED: "{\"data\":{\"password\":\"aHVudGVyMg==\"}}" },
                "managedFields": [{ "manager": "kubectl" }]
            },
            "type": "Opaque",
            "data": { "password": "aHVudGVyMg==" },
            "stringData": { "token": "plain" }
        }));
        let v = safe_value(&rref("Secret", "secrets"), secret).unwrap();
        let text = v.to_string();
        assert!(!text.contains("aHVudGVyMg=="), "{text}");
        assert!(!text.contains("plain"), "{text}");
        assert_eq!(v["data"]["password"], REDACTED);
        assert_eq!(v["stringData"]["token"], REDACTED);
        assert_eq!(v["metadata"]["annotations"][LAST_APPLIED], REDACTED);
        assert!(v["metadata"].get("managedFields").is_none());
        assert_eq!(v["kind"], "Secret");
        assert_eq!(v["type"], "Opaque");
    }

    #[test]
    fn last_applied_is_redacted_on_every_kind() {
        let cm = obj(json!({
            "metadata": {
                "name": "cfg",
                "annotations": { LAST_APPLIED: "{...}", "team": "a" }
            },
            "data": { "mode": "fast" }
        }));
        let v = safe_value(&rref("ConfigMap", "configmaps"), cm).unwrap();
        assert_eq!(v["metadata"]["annotations"][LAST_APPLIED], REDACTED);
        assert_eq!(v["metadata"]["annotations"]["team"], "a");
        // ConfigMap data is not secret.
        assert_eq!(v["data"]["mode"], "fast");
    }

    #[test]
    fn a_secrets_other_copies_are_redacted() {
        let mut v = json!({
            "kind": "Secret",
            "metadata": { "annotations": {
                "kapp.k14s.io/original": "{\"stringData\":{\"pw\":\"x\"}}",
                "note": "the pw is c2VjcmV0LXB3",
                "team": "a"
            } },
            "data": { "pw": "c2VjcmV0LXB3" }
        });
        redact_value(&mut v);
        let a = &v["metadata"]["annotations"];
        assert_eq!(a["kapp.k14s.io/original"], REDACTED);
        assert_eq!(a["note"], REDACTED);
        assert_eq!(a["team"], "a");
        assert_eq!(v["data"]["pw"], REDACTED);
    }

    #[test]
    fn secrets_inside_a_list_are_redacted() {
        let mut v = json!({
            "kind": "List",
            "items": [{ "kind": "Secret", "data": { "k": "c2VjcmV0" } }]
        });
        redact_value(&mut v);
        assert_eq!(v["items"][0]["data"]["k"], REDACTED);
    }

    #[test]
    fn describe_annotation_is_redacted() {
        let mut a: BTreeMap<String, String> = [
            (LAST_APPLIED.to_string(), "{...}".to_string()),
            ("team".to_string(), "a".to_string()),
        ]
        .into();
        redact_annotations(&mut a);
        assert_eq!(a[LAST_APPLIED], REDACTED);
        assert_eq!(a["team"], "a");
    }
}
