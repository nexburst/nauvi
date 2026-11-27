//! Custom table columns (#547): a column the user adds to a kind's table,
//! from a label, an annotation or a simple field path of the objects the
//! table already watches, so it costs no extra request. Their cells are
//! built with the row ([`super::make_row`]), so they sort and filter like
//! any other.
//!
//! Field paths are kept simple: `.spec.priorityClassName`,
//! `.spec.containers[0].image`. No wildcards or filters.

use super::jsonpath::{eval, Seg};
use super::{ColumnDef, ColumnKind, Source};
use crate::text::one_line;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// At most this many custom columns per kind: each one is a cell in every
/// row of the table.
pub const MAX_CUSTOM_COLUMNS: usize = 10;
/// A cell is cut to one line of this many characters.
pub const MAX_CUSTOM_VALUE: usize = 200;
/// The longest header name.
pub const MAX_CUSTOM_LABEL: usize = 64;
/// The longest label key, annotation key or field path.
const MAX_CUSTOM_SOURCE: usize = 256;

/// Where a custom column's value comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CustomSource {
    /// `metadata.labels[value]`.
    #[default]
    Label,
    /// `metadata.annotations[value]`.
    Annotation,
    /// A field path (`.status.podIP`).
    Field,
}

/// A column the user added to a kind's table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CustomColumn {
    /// Unique within the kind; the column's key is [`custom_key`] of it.
    pub id: String,
    /// The header.
    pub label: String,
    pub source: CustomSource,
    /// The label key, annotation key or field path.
    pub value: String,
    /// The context it was added in, for a kind defined by a CRD (`""`:
    /// every context). The backend does not look at it.
    pub context: String,
}

/// The column key of a custom column (`custom:<id>`).
pub fn custom_key(id: &str) -> String {
    format!("custom:{id}")
}

/// How a custom column's cell is read.
#[derive(Debug, Clone)]
pub(super) enum Pick {
    Label(String),
    Annotation(String),
    Path(Vec<Seg>),
}

impl Pick {
    pub(super) fn text(&self, v: &Value) -> String {
        let raw = match self {
            Pick::Label(k) => map_value(v, "labels", k),
            Pick::Annotation(k) => map_value(v, "annotations", k),
            Pick::Path(segs) => eval(v, segs)
                .into_iter()
                .map(summary)
                .collect::<Vec<_>>()
                .join(","),
        };
        one_line(&raw, MAX_CUSTOM_VALUE)
    }
}

fn map_value(v: &Value, map: &str, key: &str) -> String {
    v.get("metadata")
        .and_then(|m| m.get(map))
        .and_then(|m| m.get(key))
        .map(summary)
        .unwrap_or_default()
}

/// A value as a cell, without ever serializing a subtree: a path such as
/// `.metadata` or `.spec` is read on every watch event of every row, so an
/// object is `{…}` and an array of objects or arrays is `[n items]`. An
/// array of plain values is joined with commas, up to the cell's length.
fn summary(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(_) | Value::Number(_) => v.to_string(),
        Value::Object(o) if o.is_empty() => "{}".into(),
        Value::Object(_) => "{…}".into(),
        Value::Array(a) if a.iter().any(|x| x.is_object() || x.is_array()) => match a.len() {
            1 => "[1 item]".into(),
            n => format!("[{n} items]"),
        },
        Value::Array(a) => {
            let mut out = String::new();
            for (i, x) in a.iter().enumerate() {
                if out.len() > MAX_CUSTOM_VALUE {
                    break;
                }
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&summary(x));
            }
            out
        }
    }
}

/// Check a field path, in plain words when it is wrong.
pub fn check_field_path(path: &str) -> Result<(), String> {
    field_path(path).map(|_| ())
}

/// Parse a simple field path: `.name` parts and `[0]` indexes.
fn field_path(path: &str) -> Result<Vec<Seg>, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Type a field path, for example .spec.priorityClassName.".into());
    }
    if p.chars().count() > MAX_CUSTOM_SOURCE {
        return Err(format!(
            "The path is too long: at most {MAX_CUSTOM_SOURCE} characters."
        ));
    }
    if !p.starts_with('.') {
        return Err("A field path starts with a dot, for example .status.podIP.".into());
    }
    let chars: Vec<char> = p.chars().collect();
    let mut segs = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => {
                i += 1;
                let start = i;
                while i < chars.len() && is_name_char(chars[i]) {
                    i += 1;
                }
                if i == start {
                    let after: String = chars[..start - 1].iter().collect();
                    return Err(match chars.get(i) {
                        None | Some('.') | Some('[') if after.is_empty() => {
                            "A field name must follow the first dot, for example .metadata.name."
                                .into()
                        }
                        None | Some('.') | Some('[') => {
                            format!("A field name is missing after \"{after}.\".")
                        }
                        Some(c) => bad_char(*c),
                    });
                }
                segs.push(Seg::Field(chars[start..i].iter().collect()));
            }
            '[' => {
                let Some(len) = chars[i + 1..].iter().position(|&c| c == ']') else {
                    return Err("A \"[\" is not closed with \"]\".".into());
                };
                let inner: String = chars[i + 1..i + 1 + len].iter().collect();
                match inner.trim().parse::<usize>() {
                    Ok(n) => segs.push(Seg::Index(n)),
                    Err(_) => {
                        return Err(format!(
                        "Only numbers work in brackets, like [0]; \"[{inner}]\" is not supported."
                    ))
                    }
                }
                i += len + 2;
            }
            c => return Err(bad_char(c)),
        }
    }
    Ok(segs)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn bad_char(c: char) -> String {
    let shown = if c.is_whitespace() {
        "A space".to_string()
    } else {
        format!("\"{c}\"")
    };
    format!(
        "{shown} cannot be in a field name. Field names have letters, digits, \"-\" and \"_\"; \
         for a label or an annotation, pick Label or Annotation instead."
    )
}

/// Check a label or annotation key.
fn check_key(what: &str, key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err(format!(
            "Type the {what} key, for example app.kubernetes.io/version."
        ));
    }
    if k.chars().count() > MAX_CUSTOM_SOURCE {
        return Err(format!(
            "The {what} key is too long: at most {MAX_CUSTOM_SOURCE} characters."
        ));
    }
    if k.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("A {what} key has no spaces."));
    }
    Ok(())
}

/// What is wrong with `c`, in plain words, if anything.
pub fn check_custom_column(c: &CustomColumn) -> Result<(), String> {
    if c.id.is_empty() {
        return Err("The column has no id.".into());
    }
    let label = c.label.trim();
    if label.is_empty() {
        return Err("Give the column a name.".into());
    }
    if label.chars().count() > MAX_CUSTOM_LABEL {
        return Err(format!(
            "The name is too long: at most {MAX_CUSTOM_LABEL} characters."
        ));
    }
    match c.source {
        CustomSource::Label => check_key("label", &c.value),
        CustomSource::Annotation => check_key("annotation", &c.value),
        CustomSource::Field => check_field_path(&c.value),
    }
}

/// The table columns of `custom`, in order, after the kind's own.
pub fn custom_column_defs(custom: &[CustomColumn]) -> Result<Vec<ColumnDef>, String> {
    if custom.len() > MAX_CUSTOM_COLUMNS {
        return Err(format!(
            "A table can have at most {MAX_CUSTOM_COLUMNS} custom columns."
        ));
    }
    let mut ids: Vec<&str> = Vec::new();
    custom
        .iter()
        .map(|c| {
            check_custom_column(c).map_err(|e| format!("Column \"{}\": {e}", c.label.trim()))?;
            if ids.contains(&c.id.as_str()) {
                return Err(format!("Two custom columns have the id \"{}\".", c.id));
            }
            ids.push(&c.id);
            let pick = match c.source {
                CustomSource::Label => Pick::Label(c.value.trim().to_string()),
                CustomSource::Annotation => Pick::Annotation(c.value.trim().to_string()),
                CustomSource::Field => Pick::Path(field_path(&c.value)?),
            };
            Ok(ColumnDef {
                key: custom_key(&c.id),
                label: c.label.trim().to_string(),
                kind: ColumnKind::Text,
                default_hidden: false,
                source: Source::Custom(pick),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::make_row;
    use super::super::test_support::rref;
    use super::*;
    use kube::api::DynamicObject;
    use serde_json::json;

    fn col(id: &str, source: CustomSource, value: &str) -> CustomColumn {
        CustomColumn {
            id: id.into(),
            label: format!("Col {id}"),
            source,
            value: value.into(),
            context: String::new(),
        }
    }

    #[test]
    fn field_paths_are_simple_and_say_what_is_wrong() {
        assert_eq!(
            field_path(".spec.containers[0].image").unwrap(),
            vec![
                Seg::Field("spec".into()),
                Seg::Field("containers".into()),
                Seg::Index(0),
                Seg::Field("image".into()),
            ]
        );
        assert!(field_path(" .status.podIP ").is_ok());
        assert!(field_path(".spec.priority-class_name").is_ok());
        let err = |p: &str| field_path(p).unwrap_err();
        assert_eq!(
            err(""),
            "Type a field path, for example .spec.priorityClassName."
        );
        assert!(err("spec.x").starts_with("A field path starts with a dot"));
        assert!(err(".").starts_with("A field name must follow the first dot"));
        assert_eq!(err(".spec..x"), "A field name is missing after \".spec.\".");
        assert_eq!(err(".spec."), "A field name is missing after \".spec.\".");
        assert!(err(".spec.containers[*]").contains("\"[*]\" is not supported"));
        assert!(err(".a[?(@.b==1)]").contains("not supported"));
        assert!(err(".a[0").contains("not closed"));
        assert!(err(".metadata.labels.app/name").starts_with("\"/\" cannot be"));
        assert!(err(".a b").starts_with("A space cannot be"));
        assert!(err(&format!(".{}", "a".repeat(300))).contains("too long"));
    }

    #[test]
    fn columns_are_checked() {
        assert!(custom_column_defs(&[col("a", CustomSource::Label, "app")]).is_ok());
        let mut no_name = col("a", CustomSource::Label, "app");
        no_name.label = "  ".into();
        assert_eq!(
            check_custom_column(&no_name).unwrap_err(),
            "Give the column a name."
        );
        assert!(check_custom_column(&col("a", CustomSource::Annotation, ""))
            .unwrap_err()
            .starts_with("Type the annotation key"));
        assert!(check_custom_column(&col("a", CustomSource::Label, "a b")).is_err());
        let err = custom_column_defs(&[col("a", CustomSource::Field, "spec")]).unwrap_err();
        assert!(
            err.starts_with("Column \"Col a\": A field path starts"),
            "{err}"
        );
        let many: Vec<_> = (0..11)
            .map(|i| col(&i.to_string(), CustomSource::Label, "app"))
            .collect();
        assert!(custom_column_defs(&many)
            .unwrap_err()
            .contains("at most 10"));
        let twice = [
            col("a", CustomSource::Label, "x"),
            col("a", CustomSource::Label, "y"),
        ];
        assert!(custom_column_defs(&twice).is_err());
    }

    #[test]
    fn cells_come_from_labels_annotations_and_paths() {
        let r = rref("", "Pod", "pods", true);
        let custom = [
            col("v", CustomSource::Label, "app.kubernetes.io/version"),
            col("n", CustomSource::Annotation, "note"),
            col("ip", CustomSource::Field, ".status.podIP"),
            col("img", CustomSource::Field, ".spec.containers[1].image"),
            col("none", CustomSource::Field, ".spec.nothing[3]"),
            col("obj", CustomSource::Field, ".spec.containers[0].ports"),
        ];
        let cols = custom_column_defs(&custom).unwrap();
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {
                "name": "p", "namespace": "ns",
                "labels": {"app.kubernetes.io/version": "1.2.3"},
                "annotations": {"note": format!("line one\nline two {}", "x".repeat(400))}
            },
            "spec": {"containers": [
                {"name": "a", "image": "a:1", "ports": [{"containerPort": 80}]},
                {"name": "b", "image": "b:2"}
            ]},
            "status": {"podIP": "10.0.0.7"}
        }))
        .unwrap();
        let row = make_row(&r, &cols, &obj);
        assert_eq!(row.cells[0], "1.2.3");
        assert!(row.cells[1].starts_with("line one line two x"));
        assert_eq!(
            row.cells[1].chars().count(),
            MAX_CUSTOM_VALUE + 1,
            "cut with …"
        );
        assert_eq!(row.cells[2], "10.0.0.7");
        assert_eq!(row.cells[3], "b:2");
        assert_eq!(row.cells[4], "");
        assert_eq!(row.cells[5], "[1 item]");
        assert_eq!(cols[0].key, "custom:v");
        assert_eq!(cols[0].label, "Col v");
    }

    #[test]
    fn objects_and_arrays_are_summed_up_not_serialized() {
        assert_eq!(summary(&json!({"a": {"b": [1, 2]}})), "{…}");
        assert_eq!(summary(&json!({})), "{}");
        assert_eq!(summary(&json!([{"a": 1}, {"b": 2}, [3]])), "[3 items]");
        assert_eq!(summary(&json!([{"a": 1}])), "[1 item]");
        assert_eq!(summary(&json!(["x", 2, true, null])), "x,2,true,");
        assert_eq!(summary(&json!([])), "");
        assert_eq!(summary(&json!(7)), "7");
        // A long array of plain values stops once the cell is full.
        let long: Vec<String> = (0..10_000).map(|i| format!("item-{i}")).collect();
        assert!(summary(&json!(long)).len() < MAX_CUSTOM_VALUE + 20);

        let r = rref("", "Pod", "pods", true);
        let custom = [
            col("m", CustomSource::Field, ".metadata"),
            col("s", CustomSource::Field, ".spec.containers"),
            col("f", CustomSource::Field, ".metadata.finalizers"),
        ];
        let cols = custom_column_defs(&custom).unwrap();
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {"name": "p", "namespace": "ns", "finalizers": ["a/b", "c/d"]},
            "spec": {"containers": [{"name": "a"}, {"name": "b"}]}
        }))
        .unwrap();
        let row = make_row(&r, &cols, &obj);
        assert_eq!(row.cells[0], "{…}");
        assert_eq!(row.cells[1], "[2 items]");
        assert_eq!(row.cells[2], "a/b,c/d");
    }
}
