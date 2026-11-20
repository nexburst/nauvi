//! The masking of [`super::mask`] over a whole JSON document: kubectl's
//! last-applied-configuration annotation repeats the object's spec (args,
//! env values) as one JSON string, which the detail panel would otherwise
//! show in the clear.
//!
//! - a string under a key that names a secret (`password`, `apiKey`) is
//!   hidden whole;
//! - an `{"name": "DB_PASSWORD", "value": "…"}` pair (an env var, a header)
//!   hides its value;
//! - an array of strings (`command`, `args`) is masked as a command line;
//! - any other string is masked as text (URL passwords, `Bearer`, AWS key ids).
//!
//! Not JSON: the whole string is masked as text.

use super::mask::{mask_args, mask_text, sensitive, MASK};
use serde_json::Value;

/// `json` with secret-looking values replaced by [`MASK`] (compact JSON),
/// and whether anything was hidden.
pub fn mask_json(json: &str) -> (String, bool) {
    let Ok(mut v) = serde_json::from_str::<Value>(json) else {
        return mask_text(json);
    };
    let mut hidden = false;
    walk(&mut v, None, &mut hidden);
    let out = serde_json::to_string(&v).unwrap_or_else(|_| json.to_string());
    (out, hidden)
}

/// `apiKey` -> `api-key`, so a JSON key reads like a flag name:
/// `secretName` ends in the location segment `name`.
fn kebab(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for (i, c) in key.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('-');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn secret_key(key: Option<&str>) -> bool {
    key.is_some_and(|k| sensitive(&kebab(k)))
}

fn hide(s: &mut String, hidden: &mut bool) {
    if !s.is_empty() {
        *s = MASK.to_string();
        *hidden = true;
    }
}

fn walk(v: &mut Value, key: Option<&str>, hidden: &mut bool) {
    match v {
        Value::String(s) if secret_key(key) => hide(s, hidden),
        Value::String(s) => {
            let (m, h) = mask_text(s);
            *s = m;
            *hidden |= h;
        }
        Value::Array(items) if items.iter().all(Value::is_string) && !items.is_empty() => {
            let argv: Vec<String> = items
                .iter()
                .map(|i| i.as_str().unwrap_or_default().to_string())
                .collect();
            let (masked, h) = if secret_key(key) {
                (vec![MASK.to_string(); argv.len()], true)
            } else {
                mask_args(&argv)
            };
            *hidden |= h;
            *items = masked.into_iter().map(Value::String).collect();
        }
        Value::Array(items) => items.iter_mut().for_each(|i| walk(i, None, hidden)),
        Value::Object(map) => {
            let named_secret = map
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(sensitive);
            for (k, child) in map.iter_mut() {
                match child {
                    Value::String(s) if named_secret && k == "value" => hide(s, hidden),
                    _ => walk(child, Some(k), hidden),
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn masked(v: Value) -> (Value, bool) {
        let (s, h) = mask_json(&v.to_string());
        (serde_json::from_str(&s).unwrap(), h)
    }

    #[test]
    fn hides_args_env_and_secret_keys() {
        let (v, hidden) = masked(json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "api", "namespace": "demo" },
            "spec": { "template": { "spec": {
                "containers": [{
                    "name": "api",
                    "image": "nginx:1.25",
                    "command": ["sh", "-c", "psql postgres://u:hunter2@db/app"],
                    "args": ["--token=s3cr3t", "--port", "8080"],
                    "env": [
                        { "name": "DB_PASSWORD", "value": "hunter2" },
                        { "name": "TOKEN_FILE", "value": "/run/token" },
                        { "name": "LOG_LEVEL", "value": "debug" }
                    ],
                    "volumeMounts": [{ "name": "tls", "mountPath": "/tls" }]
                }],
                "volumes": [{ "name": "tls", "secret": { "secretName": "web-tls" } }]
            }}}
        }));
        assert!(hidden);
        let text = v.to_string();
        for secret in ["hunter2", "s3cr3t"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        let c = &v["spec"]["template"]["spec"]["containers"][0];
        assert_eq!(c["args"], json!(["--token=••••", "--port", "8080"]));
        assert_eq!(c["env"][0]["value"], "••••");
        assert_eq!(c["env"][1]["value"], "/run/token");
        assert_eq!(c["env"][2]["value"], "debug");
        assert_eq!(c["image"], "nginx:1.25");
        assert_eq!(
            v["spec"]["template"]["spec"]["volumes"][0]["secret"]["secretName"],
            "web-tls"
        );
        assert_eq!(v["metadata"]["name"], "api");
    }

    #[test]
    fn camel_case_keys_and_headers() {
        let (v, hidden) = masked(json!({
            "data": { "apiKey": "abc", "dbPassword": "def", "mode": "fast" },
            "httpHeaders": [{ "name": "Authorization", "value": "Bearer xyz" }],
            "aws": "AKIAABCDEFGHIJKLMNOP",
            "tokens": ["a", "b"]
        }));
        assert!(hidden);
        assert_eq!(v["data"]["apiKey"], "••••");
        assert_eq!(v["data"]["dbPassword"], "••••");
        assert_eq!(v["data"]["mode"], "fast");
        assert_eq!(v["httpHeaders"][0]["value"], "Bearer ••••");
        assert_eq!(v["aws"], "••••");
        assert_eq!(v["tokens"], json!(["••••", "••••"]));
    }

    #[test]
    fn nothing_to_hide_keeps_the_document() {
        let doc = json!({ "kind": "Service", "spec": { "ports": [{ "port": 80 }] } });
        let (v, hidden) = masked(doc.clone());
        assert!(!hidden);
        assert_eq!(v, doc);
    }

    #[test]
    fn not_json_is_masked_as_text() {
        let (s, hidden) = mask_json("--password=abc and more");
        assert!(hidden);
        assert_eq!(s, "--password=•••• and more");
    }
}
