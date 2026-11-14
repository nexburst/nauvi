//! The detail panel of a CustomResourceDefinition: its names, versions and
//! printer columns. Pure functions of the object; the UI adds the link to
//! its instances.

use super::jsonpath::{array_at, cell_text, path_str};
use super::related::{Fact, RelatedGroup};
use super::related_local::str_at;
use serde_json::Value;

fn yes_no(v: &Value, pointer: &str) -> String {
    if v.pointer(pointer) == Some(&Value::Bool(true)) {
        "yes".into()
    } else {
        "no".into()
    }
}

/// The version objects are stored in.
pub(super) fn storage_version(v: &Value) -> String {
    array_at(v, "/spec/versions")
        .find(|ver| ver.get("storage") == Some(&Value::Bool(true)))
        .map(|ver| str_at(ver, "/name"))
        .unwrap_or_default()
}

/// The served versions, joined: `v1,v1beta1`.
pub(super) fn served_versions(v: &Value) -> String {
    array_at(v, "/spec/versions")
        .filter(|ver| ver.get("served") == Some(&Value::Bool(true)))
        .map(|ver| str_at(ver, "/name"))
        .collect::<Vec<_>>()
        .join(",")
}

/// `Widget`, `Namespaced`, `2 versions`.
pub(super) fn summary(v: &Value) -> Vec<String> {
    let n = array_at(v, "/spec/versions").count();
    vec![
        path_str(v, ".spec.names.kind"),
        path_str(v, ".spec.scope"),
        format!("{n} version{}", if n == 1 { "" } else { "s" }),
    ]
}

pub(super) fn facts(v: &Value) -> Vec<Fact> {
    let mut out = vec![
        Fact::new("Group", path_str(v, ".spec.group")),
        Fact::new("Plural", path_str(v, ".spec.names.plural")),
        Fact::new("Storage version", storage_version(v)),
    ];
    for (label, pointer) in [
        ("Short names", "/spec/names/shortNames"),
        ("Categories", "/spec/names/categories"),
    ] {
        let items: Vec<String> = array_at(v, pointer).map(cell_text).collect();
        if !items.is_empty() {
            out.push(Fact::new(label, items.join(", ")));
        }
    }
    out
}

/// The versions table and every version's printer columns.
pub(super) fn groups(v: &Value) -> Vec<RelatedGroup> {
    let versions: Vec<&Value> = array_at(v, "/spec/versions").collect();
    let rows = versions
        .iter()
        .map(|ver| {
            vec![
                str_at(ver, "/name"),
                yes_no(ver, "/served"),
                yes_no(ver, "/storage"),
                yes_no(ver, "/deprecated"),
            ]
        })
        .collect();
    let printer = versions
        .iter()
        .flat_map(|ver| {
            array_at(ver, "/additionalPrinterColumns").map(|c| {
                vec![
                    str_at(ver, "/name"),
                    str_at(c, "/name"),
                    str_at(c, "/type"),
                    str_at(c, "/jsonPath"),
                    c.get("priority")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .to_string(),
                ]
            })
        })
        .collect();
    vec![
        RelatedGroup::plain(
            "Versions",
            &["Name", "Served", "Storage", "Deprecated"],
            rows,
        ),
        RelatedGroup::plain(
            "Printer columns",
            &["Version", "Name", "Type", "JSON path", "Priority"],
            printer,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn crd() -> Value {
        json!({
            "metadata": {"name": "widgets.example.com"},
            "spec": {
                "group": "example.com",
                "scope": "Namespaced",
                "names": {"kind": "Widget", "plural": "widgets", "shortNames": ["wg"]},
                "versions": [
                    {"name": "v1", "served": true, "storage": true,
                     "additionalPrinterColumns": [
                        {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
                        {"name": "Wide", "type": "string", "jsonPath": ".spec.wide", "priority": 1}
                     ]},
                    {"name": "v1beta1", "served": false, "storage": false, "deprecated": true}
                ]
            }
        })
    }

    #[test]
    fn crd_summary_facts_and_versions() {
        let v = crd();
        assert_eq!(summary(&v), ["Widget", "Namespaced", "2 versions"]);
        assert_eq!(storage_version(&v), "v1");
        assert_eq!(served_versions(&v), "v1");
        let facts: Vec<_> = facts(&v).into_iter().map(|f| (f.label, f.value)).collect();
        assert_eq!(facts[0], ("Group".into(), "example.com".into()));
        assert_eq!(facts[3], ("Short names".into(), "wg".into()));
        assert_eq!(facts.len(), 4);

        let g = groups(&v);
        assert_eq!(g[0].items[0].cells, ["v1", "yes", "yes", "no"]);
        assert_eq!(g[0].items[1].cells, ["v1beta1", "no", "no", "yes"]);
        assert_eq!(g[1].items.len(), 2);
        assert_eq!(
            g[1].items[1].cells,
            ["v1", "Wide", "string", ".spec.wide", "1"]
        );
    }
}
