//! Three-way merge of an edited object onto the server's newer version
//! (#495): when the object changed on the server while the user edited it,
//! the edit is re-applied on top of the latest version instead of failing,
//! unless both changed the same field.
//!
//! All three documents are compared without what the server owns (see
//! `strip_server_fields` in `ops.rs`): `status`, `resourceVersion`,
//! `generation`, `managedFields` and the like. A rollout that only updates
//! the status is not a change at all.

use anyhow::Result;
use kube::api::DynamicObject;
use serde_json::{Map, Value};

use super::ops::{object_value, strip_server_fields, to_yaml, SERVER_METADATA};
use super::ResourceRef;

/// Annotations a controller keeps up to date on the object itself: a
/// change to them alone is the server's bookkeeping too, like `status`.
const CONTROLLER_ANNOTATIONS: [&str; 2] = [
    "deployment.kubernetes.io/revision",
    "deprecated.daemonset.template.generation",
];

/// What [`rebase_onto`] found.
#[derive(Debug, PartialEq)]
pub(super) enum Rebase {
    /// The server changed only its own fields: apply this (the edit on the
    /// latest version, without the server-owned fields) without asking.
    Clean(Value),
    /// The edit re-applied on the latest version, as YAML for the editor,
    /// and the latest version itself (the new base of the diff).
    Merged {
        yaml: String,
        latest: String,
        changed: Vec<String>,
    },
    /// Fields changed both by the edit and on the server, or (`reason`)
    /// not the same object any more.
    Conflict { fields: Vec<String>, reason: String },
}

fn conflict(fields: Vec<String>) -> Rebase {
    Rebase::Conflict {
        fields,
        reason: String::new(),
    }
}

/// Why the server's version is not the object the YAML was loaded from:
/// another `uid` (deleted and created again under the same name), or a
/// `deletionTimestamp` it did not have (being deleted). `None` if it is.
fn not_the_same(base: &Value, current: &Value) -> Option<String> {
    let meta = |v: &Value, k: &str| v.pointer(&format!("/metadata/{k}")).cloned();
    let (b, c) = (meta(base, "uid"), meta(current, "uid"));
    if b.is_some() && c.is_some() && b != c {
        return Some(
            "The object was deleted and created again since you loaded it. Nothing was saved."
                .into(),
        );
    }
    if meta(current, "deletionTimestamp").is_some() && meta(base, "deletionTimestamp").is_none() {
        return Some("The object is being deleted. Nothing was saved.".into());
    }
    None
}

/// Re-apply the edit (`base` -> `mine`, `mine` already stripped by
/// `check_document`) on `current`, the server's newer version.
pub(super) fn rebase_onto(
    r: &ResourceRef,
    base: &str,
    mine: &Value,
    current: DynamicObject,
) -> Result<Rebase> {
    let Ok(mut base) = serde_yaml::from_str::<Value>(base) else {
        return Ok(conflict(Vec::new()));
    };
    // Values in full: a Secret edit reaches this point only with its
    // values revealed (`check_document` rejects hidden ones).
    let full = object_value(r, current, true)?;
    // Never apply to another object of the same name, or one going away.
    if let Some(reason) = not_the_same(&base, &full) {
        return Ok(Rebase::Conflict {
            fields: Vec::new(),
            reason,
        });
    }
    strip_server_fields(&mut base);
    let mut theirs = full.clone();
    strip_server_fields(&mut theirs);
    let merged = match merge3(&base, mine, &theirs) {
        Err(fields) => return Ok(conflict(fields)),
        Ok(merged) => merged,
    };
    let changed: Vec<String> = changed_paths(&base, &theirs)
        .into_iter()
        .filter(|p| !CONTROLLER_ANNOTATIONS.iter().any(|a| *p == annotation(a)))
        .collect();
    // Nothing the user would want to look at, or nothing the edit did not
    // already have.
    if changed.is_empty() || merged == *mine {
        return Ok(Rebase::Clean(merged));
    }
    Ok(Rebase::Merged {
        yaml: to_yaml(with_server_fields(merged, &full))?,
        latest: to_yaml(full)?,
        changed,
    })
}

fn annotation(key: &str) -> String {
    let mut p = ".metadata.annotations".to_string();
    push_key(&mut p, key);
    p
}

/// `value` with the server-owned fields of `from` put back (the reverse of
/// `strip_server_fields`), so the editor shows them as it always does.
fn with_server_fields(mut value: Value, from: &Value) -> Value {
    let (Some(root), Some(src)) = (value.as_object_mut(), from.as_object()) else {
        return value;
    };
    if let Some(status) = src.get("status") {
        root.insert("status".into(), status.clone());
    }
    if let (Some(meta), Some(src_meta)) = (
        root.get_mut("metadata").and_then(Value::as_object_mut),
        src.get("metadata").and_then(Value::as_object),
    ) {
        for key in SERVER_METADATA {
            if let Some(v) = src_meta.get(key) {
                meta.insert(key.to_string(), v.clone());
            }
        }
    }
    value
}

/// The edit (`base` -> `mine`) applied to `theirs`, or the paths of the
/// fields both sides changed differently.
///
/// Maps merge per key. Lists merge per item when all three have the same
/// length (so an edit to one container and a server change to another
/// merge), and are one value otherwise.
pub fn merge3(base: &Value, mine: &Value, theirs: &Value) -> Result<Value, Vec<String>> {
    let mut conflicts = Vec::new();
    let merged = merge_at(
        Some(base),
        Some(mine),
        Some(theirs),
        &mut String::new(),
        &mut conflicts,
    );
    if conflicts.is_empty() {
        Ok(merged.unwrap_or(Value::Null))
    } else {
        Err(conflicts)
    }
}

fn merge_at(
    base: Option<&Value>,
    mine: Option<&Value>,
    theirs: Option<&Value>,
    path: &mut String,
    conflicts: &mut Vec<String>,
) -> Option<Value> {
    if mine == base {
        return theirs.cloned();
    }
    if theirs == base || mine == theirs {
        return mine.cloned();
    }
    match (base, mine, theirs) {
        (Some(Value::Object(b)), Some(Value::Object(m)), Some(Value::Object(t))) => {
            let mut keys: Vec<&String> = b.keys().chain(m.keys()).chain(t.keys()).collect();
            keys.sort();
            keys.dedup();
            let mut out = Map::new();
            for k in keys {
                let len = path.len();
                push_key(path, k);
                if let Some(v) = merge_at(b.get(k), m.get(k), t.get(k), path, conflicts) {
                    out.insert(k.clone(), v);
                }
                path.truncate(len);
            }
            Some(Value::Object(out))
        }
        (Some(Value::Array(b)), Some(Value::Array(m)), Some(Value::Array(t)))
            if b.len() == m.len() && m.len() == t.len() =>
        {
            let mut out = Vec::with_capacity(b.len());
            for i in 0..b.len() {
                let len = path.len();
                path.push_str(&format!("[{i}]"));
                // An item cannot be absent here: keep the slot.
                let v = merge_at(Some(&b[i]), Some(&m[i]), Some(&t[i]), path, conflicts);
                out.push(v.unwrap_or(Value::Null));
                path.truncate(len);
            }
            Some(Value::Array(out))
        }
        _ => {
            conflicts.push(shown(path));
            mine.cloned()
        }
    }
}

/// The paths of the fields that differ between `a` and `b`, the way the
/// API server writes them (`.spec.replicas`,
/// `.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`).
pub fn changed_paths(a: &Value, b: &Value) -> Vec<String> {
    let mut out = Vec::new();
    diff_at(Some(a), Some(b), &mut String::new(), &mut out);
    out
}

fn diff_at(a: Option<&Value>, b: Option<&Value>, path: &mut String, out: &mut Vec<String>) {
    if a == b {
        return;
    }
    let empty = Map::new();
    // A map added or removed: name its fields.
    let (x, y) = match (a, b) {
        (Some(Value::Object(x)), Some(Value::Object(y))) => (Some(x), Some(y)),
        (None, Some(Value::Object(y))) => (Some(&empty), Some(y)),
        (Some(Value::Object(x)), None) => (Some(x), Some(&empty)),
        _ => (None, None),
    };
    if let (Some(x), Some(y)) = (x, y) {
        let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
        keys.sort();
        keys.dedup();
        for k in keys {
            let len = path.len();
            push_key(path, k);
            diff_at(x.get(k), y.get(k), path, out);
            path.truncate(len);
        }
        return;
    }
    match (a, b) {
        (Some(Value::Array(x)), Some(Value::Array(y))) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                let len = path.len();
                path.push_str(&format!("[{i}]"));
                diff_at(Some(p), Some(q), path, out);
                path.truncate(len);
            }
        }
        _ => out.push(shown(path)),
    }
}

fn push_key(path: &mut String, key: &str) {
    let plain = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if plain {
        path.push('.');
        path.push_str(key);
    } else {
        path.push_str(&format!("[{}]", Value::String(key.to_string())));
    }
}

fn shown(path: &str) -> String {
    if path.is_empty() {
        ".".to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deployments() -> ResourceRef {
        serde_json::from_value(json!({
            "group": "apps", "version": "v1", "kind": "Deployment",
            "plural": "deployments", "namespaced": true
        }))
        .unwrap()
    }

    /// A Deployment as the server holds it, as the editor loads it, and as
    /// `check_document` hands it on.
    fn server(replicas: i64, restarted: &str, rv: &str, ready: i64) -> DynamicObject {
        serde_json::from_value(json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "web", "namespace": "ns", "resourceVersion": rv,
                          "generation": 2, "uid": "u1" },
            "spec": { "replicas": replicas, "template": { "metadata": {
                "annotations": { "kubectl.kubernetes.io/restartedAt": restarted } } } },
            "status": { "readyReplicas": ready }
        }))
        .unwrap()
    }
    fn loaded(obj: DynamicObject) -> String {
        to_yaml(object_value(&deployments(), obj, false).unwrap()).unwrap()
    }
    fn edited(yaml: &str) -> Value {
        super::super::ops::check_document(
            &deployments(),
            "web",
            serde_yaml::from_str(yaml).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn a_status_only_change_is_no_conflict() {
        let base = loaded(server(1, "t1", "10", 0));
        let mine = edited(&base.replace("replicas: 1", "replicas: 3"));
        let out = rebase_onto(&deployments(), &base, &mine, server(1, "t1", "11", 1)).unwrap();
        assert_eq!(out, Rebase::Clean(mine.clone()));
    }

    #[test]
    fn a_recreated_or_terminating_object_is_never_applied_to() {
        let base = loaded(server(1, "t1", "10", 0));
        let mine = edited(&base.replace("replicas: 1", "replicas: 3"));
        // Deleted and created again with the same spec: only the status
        // would differ, but it is another object.
        let mut again = server(1, "t1", "11", 0);
        again.metadata.uid = Some("u2".into());
        let Rebase::Conflict { fields, reason } =
            rebase_onto(&deployments(), &base, &mine, again).unwrap()
        else {
            panic!("not a conflict");
        };
        assert!(fields.is_empty());
        assert!(reason.contains("deleted and created again"), "{reason}");

        let mut going = server(1, "t1", "11", 0);
        going.metadata.deletion_timestamp =
            Some(serde_json::from_value(json!("2026-11-26T10:00:00Z")).unwrap());
        let Rebase::Conflict { reason, .. } =
            rebase_onto(&deployments(), &base, &mine, going).unwrap()
        else {
            panic!("not a conflict");
        };
        assert!(reason.contains("being deleted"), "{reason}");
    }

    #[test]
    fn a_controller_annotation_is_kept_without_asking() {
        let base = loaded(server(1, "t1", "10", 0));
        let mine = edited(&base.replace("replicas: 1", "replicas: 3"));
        let mut now = server(1, "t1", "11", 1);
        now.metadata.annotations = Some(
            [(
                "deployment.kubernetes.io/revision".to_string(),
                "2".to_string(),
            )]
            .into(),
        );
        let Rebase::Clean(merged) = rebase_onto(&deployments(), &base, &mine, now).unwrap() else {
            panic!("not clean");
        };
        // The edit, and the controller's annotation as it is now.
        assert_eq!(merged["spec"]["replicas"], json!(3));
        assert_eq!(
            merged["metadata"]["annotations"]["deployment.kubernetes.io/revision"],
            json!("2")
        );
    }

    #[test]
    fn an_edit_is_reapplied_on_another_change() {
        let base = loaded(server(1, "t1", "10", 0));
        let mine = edited(&base.replace("replicas: 1", "replicas: 3"));
        let Rebase::Merged {
            yaml,
            latest,
            changed,
        } = rebase_onto(&deployments(), &base, &mine, server(1, "t2", "11", 1)).unwrap()
        else {
            panic!("not merged");
        };
        // The latest version with the edit, server fields and all.
        assert_eq!(yaml, loaded(server(3, "t2", "11", 1)));
        assert_eq!(latest, loaded(server(1, "t2", "11", 1)));
        assert_eq!(
            changed,
            vec![
                ".spec.template.metadata.annotations[\"kubectl.kubernetes.io/restartedAt\"]"
                    .to_string()
            ]
        );
    }

    #[test]
    fn the_same_field_changed_on_the_server_is_a_conflict() {
        let base = loaded(server(1, "t1", "10", 0));
        let mine = edited(&base.replace("replicas: 1", "replicas: 3"));
        let out = rebase_onto(&deployments(), &base, &mine, server(5, "t1", "11", 1)).unwrap();
        assert_eq!(out, conflict(vec![".spec.replicas".to_string()]));
        // The server made the same change: nothing to merge.
        let out = rebase_onto(&deployments(), &base, &mine, server(3, "t1", "11", 1)).unwrap();
        assert_eq!(out, Rebase::Clean(mine.clone()));
    }

    fn deploy(replicas: i64, image: &str, restarted: Option<&str>) -> Value {
        let mut v = json!({
            "metadata": { "name": "web", "labels": { "app": "web" } },
            "spec": {
                "replicas": replicas,
                "template": {
                    "metadata": {},
                    "spec": { "containers": [
                        { "name": "web", "image": image },
                        { "name": "side", "image": "busybox" }
                    ] }
                }
            }
        });
        if let Some(r) = restarted {
            v["spec"]["template"]["metadata"]["annotations"] =
                json!({ "kubectl.kubernetes.io/restartedAt": r });
        }
        v
    }

    #[test]
    fn an_edit_is_reapplied_on_a_disjoint_server_change() {
        let base = deploy(1, "nginx:1", None);
        let mine = deploy(3, "nginx:1", None);
        let theirs = deploy(1, "nginx:1", Some("2026-11-26T10:00:00Z"));
        assert_eq!(
            merge3(&base, &mine, &theirs),
            Ok(deploy(3, "nginx:1", Some("2026-11-26T10:00:00Z")))
        );
    }

    #[test]
    fn list_items_merge_when_the_lengths_match() {
        let base = deploy(1, "nginx:1", None);
        let mine = deploy(1, "nginx:2", None);
        let mut theirs = base.clone();
        theirs["spec"]["template"]["spec"]["containers"][1]["image"] = json!("busybox:2");
        let mut want = mine.clone();
        want["spec"]["template"]["spec"]["containers"][1]["image"] = json!("busybox:2");
        assert_eq!(merge3(&base, &mine, &theirs), Ok(want));
    }

    #[test]
    fn a_list_of_another_length_is_one_value() {
        let base = deploy(1, "nginx:1", None);
        let mine = deploy(1, "nginx:2", None);
        let mut theirs = base.clone();
        theirs["spec"]["template"]["spec"]["containers"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(
            merge3(&base, &mine, &theirs),
            Err(vec![".spec.template.spec.containers".to_string()])
        );
    }

    #[test]
    fn the_same_field_changed_on_both_sides_is_a_conflict() {
        let base = deploy(1, "nginx:1", None);
        let mine = deploy(3, "nginx:1", None);
        let theirs = deploy(5, "nginx:1", None);
        assert_eq!(
            merge3(&base, &mine, &theirs),
            Err(vec![".spec.replicas".to_string()])
        );
        // The same new value on both sides is no conflict.
        assert_eq!(merge3(&base, &mine, &mine), Ok(mine.clone()));
    }

    #[test]
    fn added_and_removed_keys_merge() {
        let base = json!({ "data": { "a": "1", "b": "1" } });
        let mine = json!({ "data": { "a": "1", "b": "1", "c": "1" } });
        let theirs = json!({ "data": { "a": "1" } });
        assert_eq!(
            merge3(&base, &mine, &theirs),
            Ok(json!({ "data": { "a": "1", "c": "1" } }))
        );
        // Removed here, changed there: a conflict.
        let mine = json!({ "data": { "a": "1" } });
        let theirs = json!({ "data": { "a": "1", "b": "2" } });
        assert_eq!(
            merge3(&base, &mine, &theirs),
            Err(vec![".data.b".to_string()])
        );
    }

    #[test]
    fn changed_paths_name_keys_like_the_api_server() {
        let a = deploy(1, "nginx:1", None);
        let b = deploy(2, "nginx:1", Some("now"));
        assert_eq!(
            changed_paths(&a, &b),
            vec![
                ".spec.replicas".to_string(),
                ".spec.template.metadata.annotations[\"kubectl.kubernetes.io/restartedAt\"]"
                    .to_string()
            ]
        );
        let mut c = b.clone();
        c["spec"]["template"]["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"] =
            json!("later");
        assert_eq!(
            changed_paths(&b, &c),
            vec![
                ".spec.template.metadata.annotations[\"kubectl.kubernetes.io/restartedAt\"]"
                    .to_string()
            ]
        );
        assert!(changed_paths(&a, &a).is_empty());
    }
}
