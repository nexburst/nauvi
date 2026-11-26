//! A release's rendered manifest: hiding Secret values and listing the
//! objects it creates.

use crate::resources::REDACTED;
use serde::Serialize;
use serde_yaml::Value;

/// One object of a release's manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmResource {
    pub api_version: String,
    pub kind: String,
    /// As in the manifest, else the release's namespace (also for
    /// cluster-scoped kinds: callers that know the kind ignore it).
    pub namespace: String,
    pub name: String,
}

/// The documents of a multi-document YAML text, each with the `---` line
/// that precedes it (empty for the first one if the text does not start
/// with a separator).
fn documents(text: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut sep = "";
    let mut start = 0;
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end();
        if bare == "---" || bare.starts_with("--- ") {
            out.push((sep, &text[start..pos]));
            sep = line;
            start = pos + line.len();
        }
        pos += line.len();
    }
    out.push((sep, &text[start..]));
    out.retain(|(sep, body)| !(sep.is_empty() && body.is_empty()));
    out
}

fn parse(body: &str) -> Option<Value> {
    serde_yaml::from_str::<Value>(body)
        .ok()
        .filter(Value::is_mapping)
}

fn is_secret(doc: &Value) -> bool {
    doc.get("kind").and_then(Value::as_str) == Some("Secret")
        && doc
            .get("apiVersion")
            .and_then(Value::as_str)
            .is_none_or(|v| v == "v1")
}

/// Replace the values of `data` and `stringData`; whether any were there.
fn redact(doc: &mut Value) -> bool {
    let mut hid = false;
    for field in ["data", "stringData"] {
        if let Some(map) = doc.get_mut(field).and_then(Value::as_mapping_mut) {
            for (_, v) in map.iter_mut() {
                *v = Value::String(REDACTED.into());
                hid = true;
            }
        }
    }
    hid
}

/// The manifest with every Secret's `data` and `stringData` values
/// replaced by [`REDACTED`], and whether anything was hidden. Other
/// documents are kept byte for byte; a Secret document keeps its leading
/// comments (Helm's `# Source:` line) and is re-serialized.
pub fn redact_manifest(manifest: &str) -> (String, bool) {
    let mut out = String::with_capacity(manifest.len());
    let mut any = false;
    for (sep, body) in documents(manifest) {
        out.push_str(sep);
        let redacted = parse(body)
            .filter(is_secret)
            .and_then(|mut doc| redact(&mut doc).then_some(doc));
        match redacted {
            Some(doc) => {
                any = true;
                for line in body.lines() {
                    let t = line.trim_start();
                    if t.is_empty() || t.starts_with('#') {
                        out.push_str(line);
                        out.push('\n');
                    } else {
                        break;
                    }
                }
                // A mapping always serializes.
                out.push_str(&serde_yaml::to_string(&doc).unwrap_or_default());
            }
            _ => out.push_str(body),
        }
    }
    (out, any)
}

/// The objects in a manifest, in order, each with its parsed document.
/// Documents without a kind and a name (empty ones, comments only) are
/// skipped; `List` documents are not expanded.
fn objects(manifest: &str, release_namespace: &str) -> Vec<(HelmResource, Value)> {
    let text = |v: &Value, path: &[&str]| -> Option<String> {
        let mut cur = v;
        for p in path {
            cur = cur.get(*p)?;
        }
        cur.as_str().map(str::to_string)
    };
    documents(manifest)
        .into_iter()
        .filter_map(|(_, body)| parse(body))
        .filter_map(|doc| {
            let r = HelmResource {
                api_version: text(&doc, &["apiVersion"]).unwrap_or_default(),
                kind: text(&doc, &["kind"])?,
                name: text(&doc, &["metadata", "name"])?,
                namespace: text(&doc, &["metadata", "namespace"])
                    .unwrap_or_else(|| release_namespace.to_string()),
            };
            Some((r, doc))
        })
        .collect()
}

/// The objects in a manifest, in order (see [`objects`]).
pub fn manifest_resources(manifest: &str, release_namespace: &str) -> Vec<HelmResource> {
    objects(manifest, release_namespace)
        .into_iter()
        .map(|(r, _)| r)
        .collect()
}

/// What applying the manifest `new` over the release's current manifest
/// `old` would do to each object.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestChanges {
    /// In `new` only.
    pub created: Vec<HelmResource>,
    /// In both, with different content.
    pub changed: Vec<HelmResource>,
    /// In `old` only.
    pub deleted: Vec<HelmResource>,
    /// The objects in `new`.
    pub total: usize,
}

impl ManifestChanges {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.changed.is_empty() && self.deleted.is_empty()
    }
}

/// Compare two manifests object by object. An object is the same one when
/// its kind, namespace and name match (an `apiVersion` change is a change
/// to it); it changed when its parsed documents differ, so comments,
/// indentation, quoting and key order do not count, and neither do
/// documents that are not objects. Compare both sides with the same
/// redaction, or none.
pub fn manifest_changes(old: &str, new: &str, release_namespace: &str) -> ManifestChanges {
    let key = |r: &HelmResource| (r.kind.clone(), r.namespace.clone(), r.name.clone());
    let old = objects(old, release_namespace);
    let new = objects(new, release_namespace);
    let mut out = ManifestChanges {
        total: new.len(),
        ..Default::default()
    };
    for (r, doc) in &new {
        match old.iter().find(|(o, _)| key(o) == key(r)) {
            None => out.created.push(r.clone()),
            Some((_, before)) if before != doc => out.changed.push(r.clone()),
            Some(_) => {}
        }
    }
    for (r, _) in &old {
        if !new.iter().any(|(n, _)| key(n) == key(r)) {
            out.deleted.push(r.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = "---
# Source: demo/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: fx-secret
type: Opaque
stringData:
  password: \"hunter2\"
data:
  token: aHVudGVyMg==
---
# Source: demo/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fx-config   # keep me
  namespace: other
data:
  greeting: \"bye\"
---
# Source: demo/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fx-app
";

    #[test]
    fn splits_documents_with_their_separators() {
        let docs = documents("a: 1\n---\nb: 2\n--- # c\nc: 3");
        assert_eq!(
            docs,
            vec![("", "a: 1\n"), ("---\n", "b: 2\n"), ("--- # c\n", "c: 3")]
        );
        assert_eq!(documents("---\nx: 1\n"), vec![("---\n", "x: 1\n")]);
        assert_eq!(documents(""), vec![]);
    }

    #[test]
    fn hides_secret_values_and_keeps_everything_else() {
        let (out, hidden) = redact_manifest(MANIFEST);
        assert!(hidden);
        assert!(
            !out.contains("hunter2") && !out.contains("aHVudGVyMg=="),
            "{out}"
        );
        assert!(out.contains(&format!("password: '{REDACTED}'")), "{out}");
        assert!(out.contains(&format!("token: '{REDACTED}'")), "{out}");
        assert!(out.starts_with("---\n# Source: demo/templates/secret.yaml\napiVersion: v1\n"));
        // Other documents are untouched, comments included.
        let rest = &MANIFEST[MANIFEST
            .find("---\n# Source: demo/templates/configmap")
            .unwrap()..];
        assert!(out.ends_with(rest), "{out}");
        assert_eq!(out.matches("\n---\n").count(), 2, "{out}");
    }

    #[test]
    fn nothing_to_hide() {
        let text = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: empty\n---\nkind: ConfigMap\n";
        assert_eq!(redact_manifest(text), (text.to_string(), false));
        // Not the core Secret kind.
        let crd = "apiVersion: example.com/v1\nkind: Secret\ndata:\n  a: b\n";
        assert_eq!(redact_manifest(crd), (crd.to_string(), false));
        // Unparsable documents pass through.
        let bad = "kind: Secret\ndata: [unclosed\n";
        assert_eq!(redact_manifest(bad), (bad.to_string(), false));
    }

    #[test]
    fn lists_the_objects() {
        let r = manifest_resources(MANIFEST, "rel-ns");
        let short: Vec<_> = r
            .iter()
            .map(|r| format!("{} {} {}/{}", r.api_version, r.kind, r.namespace, r.name))
            .collect();
        assert_eq!(
            short,
            [
                "v1 Secret rel-ns/fx-secret",
                "v1 ConfigMap other/fx-config",
                "apps/v1 Deployment rel-ns/fx-app"
            ]
        );
        assert!(manifest_resources("---\n# only a comment\n---\n", "x").is_empty());
    }

    #[test]
    fn compares_objects_not_text() {
        let old = "---\n# Source: a.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  greeting: \"hello\"\n  other: x\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n";
        // Other comments, quoting, indentation and key order: no change.
        let same = "# Source: b.yaml\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: cfg}\ndata:\n    other: 'x'\n    greeting: hello\n---\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n";
        let c = manifest_changes(old, same, "ns");
        assert!(c.is_empty(), "{c:?}");
        assert_eq!(c.total, 2);

        let new = old.replace("hello", "hola");
        let c = manifest_changes(old, &new, "ns");
        let names = |v: &[HelmResource]| {
            v.iter()
                .map(|r| format!("{} {}", r.kind, r.name))
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&c.changed), ["ConfigMap cfg"]);
        assert!(c.created.is_empty() && c.deleted.is_empty());
        assert_eq!(c.total, 2);
    }

    #[test]
    fn finds_created_and_deleted_objects() {
        let old =
            "kind: ConfigMap\nmetadata:\n  name: a\n---\nkind: ConfigMap\nmetadata:\n  name: b\n";
        // Same name in another namespace is another object; an apiVersion
        // change is a change.
        let new = "kind: ConfigMap\nmetadata:\n  name: a\n  namespace: other\n---\napiVersion: v2\nkind: ConfigMap\nmetadata:\n  name: b\n";
        let c = manifest_changes(old, new, "ns");
        let short = |v: &[HelmResource]| {
            v.iter()
                .map(|r| format!("{}/{}", r.namespace, r.name))
                .collect::<Vec<_>>()
        };
        assert_eq!(short(&c.created), ["other/a"]);
        assert_eq!(short(&c.changed), ["ns/b"]);
        assert_eq!(short(&c.deleted), ["ns/a"]);
        // An install: everything is created.
        let c = manifest_changes("", MANIFEST, "ns");
        assert_eq!((c.created.len(), c.total), (3, 3));
        // Explicit and implied release namespace are the same object
        // (whose document changed).
        let c = manifest_changes(
            old,
            &old.replace("name: a\n", "name: a\n  namespace: ns\n"),
            "ns",
        );
        assert_eq!(short(&c.changed), ["ns/a"]);
        assert!(c.created.is_empty() && c.deleted.is_empty(), "{c:?}");
    }
}
