//! Annotations that copy a Secret (#415). `kubectl apply` keeps the whole
//! object in `last-applied-configuration`; other tools do the same under
//! their own key (kapp's `kapp.k14s.io/original`, and more). On a Secret,
//! any of these shows its values in the clear, so they are redacted
//! wherever its values are: the detail panel, the YAML tab, the CLI and the
//! MCP server.
//!
//! An annotation of a Secret counts as a copy when it is:
//!
//! - kubectl's last-applied-configuration;
//! - a JSON or YAML document with a `data` or `stringData` key at any depth,
//!   or text that starts like a JSON object and names one of them;
//! - or text that contains one of the Secret's values (as stored, or
//!   decoded) of at least [`MIN_VALUE_LEN`] characters.

use base64::Engine;
use serde_json::Value;

pub(super) const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Shorter values are not looked for inside annotations: too many false
/// matches (`true`, `80`), and a short secret is not hidden by its size.
pub const MIN_VALUE_LEN: usize = 6;

const SECRET_FIELDS: [&str; 2] = ["data", "stringData"];

/// The keys of the annotations of `secret` (a Secret as JSON, its values
/// not yet redacted) that copy it.
pub fn secret_copy_keys(secret: &Value) -> Vec<String> {
    let Some(annotations) = secret
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
    else {
        return vec![];
    };
    let values = secret_values(secret);
    annotations
        .iter()
        .filter(|(k, v)| copies_secret(k, v.as_str().unwrap_or_default(), &values))
        .map(|(k, _)| k.clone())
        .collect()
}

/// Whether the annotation `key: value` copies a Secret whose values are
/// `values` (from [`secret_values`]).
pub fn copies_secret(key: &str, value: &str, values: &[String]) -> bool {
    key == LAST_APPLIED || names_secret_fields(value) || values.iter().any(|s| value.contains(s))
}

/// The values of `secret`'s `data` (as stored and decoded) and
/// `stringData`, those of at least [`MIN_VALUE_LEN`] characters.
pub fn secret_values(secret: &Value) -> Vec<String> {
    let strings = |field: &str| {
        secret
            .get(field)
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|m| m.values().filter_map(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>()
    };
    let data = strings("data");
    let decoded = data.iter().filter_map(|d| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(d).ok()?;
        String::from_utf8(bytes).ok()
    });
    let mut out: Vec<String> = data
        .iter()
        .cloned()
        .chain(decoded)
        .chain(strings("stringData"))
        .filter(|v| v.trim().chars().count() >= MIN_VALUE_LEN)
        .collect();
    out.sort();
    out.dedup();
    out
}

fn names_secret_fields(value: &str) -> bool {
    let t = value.trim_start();
    if t.starts_with('{')
        && SECRET_FIELDS
            .iter()
            .any(|f| t.contains(&format!("\"{f}\"")))
    {
        return true;
    }
    let parsed = serde_json::from_str::<Value>(value)
        .ok()
        .or_else(|| serde_yaml::from_str::<Value>(value).ok());
    parsed.is_some_and(|v| has_secret_field(&v))
}

fn has_secret_field(v: &Value) -> bool {
    match v {
        Value::Object(m) => m
            .iter()
            .any(|(k, child)| SECRET_FIELDS.contains(&k.as_str()) || has_secret_field(child)),
        Value::Array(items) => items.iter().any(has_secret_field),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KAPP: &str = "kapp.k14s.io/original";

    fn secret(annotations: Value) -> Value {
        json!({
            "kind": "Secret",
            "metadata": { "name": "creds", "annotations": annotations },
            // "hunter2-pw"
            "data": { "password": "aHVudGVyMi1wdw==", "short": "YQ==" },
            "stringData": { "token": "tok-123456" }
        })
    }

    fn keys(annotations: Value) -> Vec<String> {
        secret_copy_keys(&secret(annotations))
    }

    #[test]
    fn last_applied_and_kapp_original_are_copies() {
        let original = json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "creds" },
            "stringData": { "password": "x" }
        })
        .to_string();
        assert_eq!(
            keys(json!({ LAST_APPLIED: "{}", KAPP: original, "team": "a" })),
            vec![KAPP.to_string(), LAST_APPLIED.to_string()]
        );
    }

    #[test]
    fn json_yaml_or_truncated_documents_with_data_are_copies() {
        let nested = json!({ "spec": { "template": { "data": {} } } }).to_string();
        let got = keys(json!({
            "a/nested": nested,
            "b/yaml": "kind: Secret\ndata:\n  k: dg==\n",
            "c/truncated": "{\"kind\":\"Secret\",\"stringData\":{\"password\":\"x",
            "d/plain": "managed by the platform team",
            "e/json-no-data": "{\"replicas\": 3}",
        }));
        assert_eq!(got, vec!["a/nested", "b/yaml", "c/truncated"]);
    }

    #[test]
    fn a_value_inside_any_text_is_a_copy() {
        let got = keys(json!({
            "stored": "copy aHVudGVyMi1wdw== here",
            "decoded": "pw is hunter2-pw",
            "string-data": "tok-123456",
            // "a": too short to look for.
            "short": "a",
        }));
        assert_eq!(got, vec!["decoded", "stored", "string-data"]);
    }

    #[test]
    fn no_annotations_no_keys() {
        assert!(secret_copy_keys(&json!({ "kind": "Secret", "data": {} })).is_empty());
    }
}
