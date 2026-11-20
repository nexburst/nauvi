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
//! - or text that contains one of the Secret's values (as stored, decoded,
//!   or trimmed) of at least [`MIN_VALUE_LEN`] characters;
//! - or any of these once base64-decoded, or gunzipped after that
//!   (Rancher/Fleet's `objectset.rio.cattle.io/applied`). A gzip stream
//!   that inflates past [`MAX_INFLATED`] counts as a copy: it cannot be
//!   checked, and hiding it costs little.

use base64::Engine;
use serde_json::Value;
use std::io::Read;

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
    let copy = |text: &str| names_secret_fields(text) || values.iter().any(|s| text.contains(s));
    key == LAST_APPLIED
        || copy(value)
        || match decoded(value) {
            Decoded::No => false,
            Decoded::TooLarge => true,
            Decoded::Text(t) => copy(&t),
        }
}

/// Encoded annotations larger than this are not decoded (annotations are
/// at most 256 KiB in all).
pub const MAX_ENCODED: usize = 1024 * 1024;
/// How far a gzip stream is inflated before it counts as a copy.
pub const MAX_INFLATED: u64 = 4 * 1024 * 1024;

enum Decoded {
    No,
    TooLarge,
    Text(String),
}

/// `value` read as base64, gunzipped when it is a gzip stream.
fn decoded(value: &str) -> Decoded {
    let v = value.trim();
    if v.len() < 8 || v.len() > MAX_ENCODED {
        return Decoded::No;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(v) else {
        return Decoded::No;
    };
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return String::from_utf8(bytes).map_or(Decoded::No, Decoded::Text);
    }
    let mut out = Vec::new();
    let gz = flate2::read::GzDecoder::new(bytes.as_slice());
    match gz.take(MAX_INFLATED + 1).read_to_end(&mut out) {
        Ok(n) if n as u64 > MAX_INFLATED => Decoded::TooLarge,
        Ok(_) => Decoded::Text(String::from_utf8_lossy(&out).into_owned()),
        Err(_) => Decoded::No,
    }
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
        // `pw\n` from a file is copied as `pw` as often as not.
        .flat_map(|v| [v.trim().to_string(), v])
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

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(bytes).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn base64_and_gzipped_copies_are_found() {
        let doc = json!({ "kind": "Secret", "data": { "pw": "x" } }).to_string();
        let got = keys(json!({
            "objectset.rio.cattle.io/applied": b64(&gzip(doc.as_bytes())),
            "b/base64": b64(doc.as_bytes()),
            "c/gz-value": b64(&gzip(b"the pw: hunter2-pw")),
            "d/plain-gz": b64(&gzip(b"nothing to see here")),
            "e/word": "platform",
        }));
        assert_eq!(
            got,
            vec!["b/base64", "c/gz-value", "objectset.rio.cattle.io/applied"]
        );
    }

    #[test]
    fn a_gzip_bomb_counts_as_a_copy() {
        let big = vec![b'a'; MAX_INFLATED as usize + 10];
        assert!(keys(json!({ "bomb": b64(&gzip(&big)) })).contains(&"bomb".to_string()));
        // Too large to decode at all: left as it is.
        let huge = "A".repeat(MAX_ENCODED + 4);
        assert!(keys(json!({ "huge": huge })).is_empty());
    }

    #[test]
    fn values_with_a_trailing_newline_match_when_copied_trimmed() {
        let s = json!({
            "kind": "Secret",
            "metadata": { "annotations": { "note": "token is tok-from-file ok" } },
            // "tok-from-file\n"
            "data": { "t": "dG9rLWZyb20tZmlsZQo=" },
            "stringData": { "u": "user-from-file\n" }
        });
        assert_eq!(secret_copy_keys(&s), vec!["note"]);
        let values = secret_values(&s);
        assert!(values.contains(&"tok-from-file".to_string()));
        assert!(values.contains(&"user-from-file".to_string()));
    }

    #[test]
    fn no_annotations_no_keys() {
        assert!(secret_copy_keys(&json!({ "kind": "Secret", "data": {} })).is_empty());
    }
}
