//! The key/value data of Secrets and ConfigMaps (#224): the keys for the
//! detail panel's data editor, one Secret value at a time on request, and a
//! JSON merge patch that changes only the edited keys.
//!
//! Secret values never leave this module unless asked for one key at a
//! time ([`reveal_data_value`]), and never appear in an error message
//! ([`scrub`]): the UI forwards errors to the app log.

use super::ops::{is_secret, object_api, FIELD_MANAGER};
use super::*;
use anyhow::{bail, Result};
use base64::Engine as _;
use kube::api::{DynamicObject, Patch, PatchParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Which map of the object an entry is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum DataField {
    /// `data`: base64 in a Secret, text in a ConfigMap.
    Data,
    /// A ConfigMap's `binaryData` (base64).
    BinaryData,
}

/// How a value is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum DataEncoding {
    /// The value as text (UTF-8).
    Text,
    /// The bytes, base64-encoded.
    Base64,
}

/// One key of a Secret or ConfigMap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DataEntry {
    pub key: String,
    pub field: DataField,
    /// Size of the (decoded) value.
    pub bytes: u32,
    /// Not valid UTF-8: shown (and edited) as base64.
    pub binary: bool,
    /// A Secret's values are never listed: empty and `hidden` until
    /// [`reveal_data_value`]. A ConfigMap's value is here, as text, or as
    /// base64 if `binary`.
    pub value: String,
    pub hidden: bool,
}

/// The data of a Secret or ConfigMap, and the version it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DataEntries {
    pub resource_version: String,
    /// `immutable: true`: the API server refuses any change of the data.
    pub immutable: bool,
    pub entries: Vec<DataEntry>,
}

/// One Secret value, revealed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RevealedValue {
    /// Text, or base64 if `binary`.
    pub value: String,
    pub binary: bool,
}

/// One change of a data save.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DataChange {
    pub key: String,
    pub field: DataField,
    /// Removes the key; `value` is ignored.
    pub delete: bool,
    pub value: String,
    pub encoding: DataEncoding,
}

fn check_kind(r: &ResourceRef) -> Result<bool> {
    if is_secret(r) {
        Ok(true)
    } else if r.is("", "ConfigMap") {
        Ok(false)
    } else {
        bail!("{} has no key/value data to edit", r.kind)
    }
}

/// Text if `bytes` is UTF-8, else `None`.
fn as_text(bytes: Vec<u8>) -> Option<String> {
    String::from_utf8(bytes).ok()
}

/// The entries of `obj` (a Secret if `secret`, else a ConfigMap), sorted
/// by key. Secret values are left out.
pub fn entries_of(secret: bool, obj: &Value) -> DataEntries {
    let map_at = |p: &str| obj.pointer(p).and_then(Value::as_object).cloned();
    let mut entries = Vec::new();
    for (k, v) in map_at("/data").unwrap_or_default() {
        let s = v.as_str().unwrap_or_default();
        let entry = if secret {
            let decoded = B64.decode(s).unwrap_or_default();
            DataEntry {
                key: k,
                field: DataField::Data,
                bytes: decoded.len() as u32,
                binary: std::str::from_utf8(&decoded).is_err(),
                value: String::new(),
                hidden: true,
            }
        } else {
            DataEntry {
                key: k,
                field: DataField::Data,
                bytes: s.len() as u32,
                binary: false,
                value: s.to_string(),
                hidden: false,
            }
        };
        entries.push(entry);
    }
    if !secret {
        for (k, v) in map_at("/binaryData").unwrap_or_default() {
            let s = v.as_str().unwrap_or_default();
            entries.push(DataEntry {
                key: k,
                field: DataField::BinaryData,
                bytes: B64.decode(s).map(|b| b.len()).unwrap_or_default() as u32,
                binary: true,
                value: s.to_string(),
                hidden: false,
            });
        }
    }
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    DataEntries {
        resource_version: obj
            .pointer("/metadata/resourceVersion")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        immutable: obj.get("immutable").and_then(Value::as_bool) == Some(true),
        entries,
    }
}

async fn get_value(client: &Client, r: &ResourceRef, namespace: &str, name: &str) -> Result<Value> {
    let obj: DynamicObject = object_api(client, r, namespace)?.get(name).await?;
    Ok(serde_json::to_value(obj)?)
}

/// The keys of a Secret (without values) or ConfigMap (with them).
pub async fn get_data_entries(
    client: &Client,
    r: &ResourceRef,
    namespace: &str,
    name: &str,
) -> Result<DataEntries> {
    let secret = check_kind(r)?;
    Ok(entries_of(secret, &get_value(client, r, namespace, name).await?))
}

/// The value of one key of a Secret: text if it is UTF-8, else base64.
pub fn revealed_of(obj: &Value, key: &str) -> Result<RevealedValue> {
    let Some(raw) = obj.pointer("/data").and_then(|d| d.get(key)) else {
        bail!("the Secret has no key \"{key}\" any more");
    };
    let raw = raw.as_str().unwrap_or_default();
    let Ok(bytes) = B64.decode(raw) else {
        bail!("the value of \"{key}\" is not valid base64");
    };
    Ok(match as_text(bytes) {
        Some(value) => RevealedValue {
            value,
            binary: false,
        },
        None => RevealedValue {
            value: raw.to_string(),
            binary: true,
        },
    })
}

/// Read one Secret value (the user asked to see it).
pub async fn reveal_data_value(
    client: &Client,
    r: &ResourceRef,
    namespace: &str,
    name: &str,
    key: &str,
) -> Result<RevealedValue> {
    if !is_secret(r) {
        bail!("only Secret values are hidden");
    }
    revealed_of(&get_value(client, r, namespace, name).await?, key)
}

/// A valid key of a Secret or ConfigMap: what `kubectl` accepts.
fn check_key(key: &str) -> Result<()> {
    if key.is_empty() {
        bail!("a key cannot be empty");
    }
    if key.len() > 253 {
        bail!("the key \"{key}\" is longer than 253 characters");
    }
    if key == "." || key == ".." {
        bail!("\"{key}\" is not a valid key");
    }
    if let Some(c) = key
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
    {
        bail!("the key \"{key}\" has '{c}': only letters, digits, '-', '_' and '.' are allowed");
    }
    Ok(())
}

/// The JSON merge patch for `changes`: only the changed keys, `null` for a
/// removed one, and `metadata.resourceVersion` as a precondition if given.
pub fn data_patch(secret: bool, changes: &[DataChange], resource_version: &str) -> Result<Value> {
    if changes.is_empty() {
        bail!("nothing to save");
    }
    let mut data = Map::new();
    let mut binary = Map::new();
    for c in changes {
        check_key(&c.key)?;
        if !secret && c.field == DataField::Data && c.encoding == DataEncoding::Base64 && !c.delete
        {
            bail!("\"{}\" is a text key: its value cannot be base64", c.key);
        }
        if secret && c.field == DataField::BinaryData {
            bail!("a Secret has no binaryData");
        }
        let value = if c.delete {
            Value::Null
        } else {
            let base64 = || -> Result<String> {
                let v: String = c.value.chars().filter(|c| !c.is_whitespace()).collect();
                if B64.decode(&v).is_err() {
                    bail!("the value of \"{}\" is not valid base64", c.key);
                }
                Ok(v)
            };
            Value::String(match (secret, c.encoding) {
                (true, DataEncoding::Text) => B64.encode(c.value.as_bytes()),
                (_, DataEncoding::Base64) => base64()?,
                (false, DataEncoding::Text) => c.value.clone(),
            })
        };
        let map = match c.field {
            DataField::Data => &mut data,
            DataField::BinaryData => &mut binary,
        };
        if map.insert(c.key.clone(), value).is_some() {
            bail!("\"{}\" is changed twice", c.key);
        }
    }
    let mut patch = Map::new();
    if !resource_version.is_empty() {
        patch.insert(
            "metadata".into(),
            serde_json::json!({ "resourceVersion": resource_version }),
        );
    }
    if !data.is_empty() {
        patch.insert("data".into(), Value::Object(data));
    }
    if !binary.is_empty() {
        patch.insert("binaryData".into(), Value::Object(binary));
    }
    Ok(Value::Object(patch))
}

/// `text` without any of the new values in `changes` (as given, and as
/// base64), so an error never carries a Secret value into the log.
pub fn scrub(text: &str, changes: &[DataChange]) -> String {
    let mut out = text.to_string();
    for c in changes.iter().filter(|c| !c.delete) {
        for v in [c.value.clone(), B64.encode(c.value.as_bytes())] {
            if v.trim().len() >= 3 {
                out = out.replace(v.trim(), "[hidden]");
            }
        }
    }
    out
}

/// Save `changes` with a JSON merge patch (field manager "kubeloupe").
/// `resource_version` is the version the data was loaded at (empty: don't
/// check); if the object changed since, nothing is saved and the outcome is
/// [`ApplyOutcome::Conflict`]. Errors are already plain text, and never
/// contain the values (see [`scrub`]).
pub async fn patch_data(
    client: &Client,
    r: &ResourceRef,
    namespace: &str,
    name: &str,
    changes: &[DataChange],
    resource_version: &str,
) -> std::result::Result<ApplyOutcome, String> {
    let text = |e: anyhow::Error| scrub(&crate::actions::describe_error(&e), changes);
    let secret = check_kind(r).map_err(text)?;
    let patch = data_patch(secret, changes, resource_version).map_err(text)?;
    let api = object_api(client, r, namespace).map_err(text)?;
    let params = PatchParams {
        field_manager: Some(FIELD_MANAGER.to_string()),
        ..PatchParams::default()
    };
    match api.patch(name, &params, &Patch::Merge(&patch)).await {
        Ok(_) => Ok(ApplyOutcome::Applied {
            takeovers: Vec::new(),
        }),
        Err(kube::Error::Api(e)) if e.code == 409 && !resource_version.is_empty() => {
            let current = api
                .get_metadata(name)
                .await
                .map_err(|e| text(e.into()))?
                .metadata
                .resource_version
                .unwrap_or_default();
            Ok(ApplyOutcome::Conflict {
                resource_version: current,
            })
        }
        Err(e) => Err(text(e.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(key: &str, value: &str, encoding: DataEncoding) -> DataChange {
        DataChange {
            key: key.into(),
            field: DataField::Data,
            delete: false,
            value: value.into(),
            encoding,
        }
    }

    #[test]
    fn secret_entries_have_no_values() {
        let obj = json!({
            "metadata": {"resourceVersion": "12"},
            "data": {"password": "aHVudGVyMg==", "blob": "/w==", "a": ""},
        });
        let got = entries_of(true, &obj);
        assert_eq!(got.resource_version, "12");
        assert!(!got.immutable);
        let keys: Vec<_> = got.entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["a", "blob", "password"]);
        assert!(got.entries.iter().all(|e| e.hidden && e.value.is_empty()));
        assert_eq!(got.entries[2].bytes, 7);
        assert!(got.entries[1].binary);
        assert!(!got.entries[2].binary);
        assert!(!serde_json::to_string(&got).unwrap().contains("aHVudGVy"));
    }

    #[test]
    fn configmap_entries_have_values() {
        let obj = json!({
            "immutable": true,
            "data": {"conf": "a=1"},
            "binaryData": {"bin": "AAEC"},
        });
        let got = entries_of(false, &obj);
        assert!(got.immutable);
        assert_eq!(got.entries[0].key, "bin");
        assert_eq!(got.entries[0].field, DataField::BinaryData);
        assert_eq!(got.entries[0].bytes, 3);
        assert!(got.entries[0].binary);
        assert_eq!(got.entries[1].value, "a=1");
        assert!(!got.entries[1].hidden);
    }

    #[test]
    fn reveal_decodes_text_and_keeps_binary_as_base64() {
        let obj = json!({"data": {"p": "aHVudGVyMg==", "b": "/w=="}});
        assert_eq!(revealed_of(&obj, "p").unwrap().value, "hunter2");
        let b = revealed_of(&obj, "b").unwrap();
        assert!(b.binary);
        assert_eq!(b.value, "/w==");
        let gone = revealed_of(&obj, "x").unwrap_err().to_string();
        assert!(gone.contains("no key \"x\""), "{gone}");
    }

    #[test]
    fn patch_has_only_the_changed_keys() {
        let mut del = change("old", "", DataEncoding::Text);
        del.delete = true;
        let changes = [
            change("password", "hunter2", DataEncoding::Text),
            change("blob", "/w ==", DataEncoding::Base64),
            del,
        ];
        let p = data_patch(true, &changes, "7").unwrap();
        assert_eq!(
            p,
            json!({
                "metadata": {"resourceVersion": "7"},
                "data": {"password": "aHVudGVyMg==", "blob": "/w==", "old": null},
            })
        );
        let cm = data_patch(false, &[change("conf", "a=1", DataEncoding::Text)], "").unwrap();
        assert_eq!(cm, json!({"data": {"conf": "a=1"}}));
        let mut bin = change("bin", "AAEC", DataEncoding::Base64);
        bin.field = DataField::BinaryData;
        let cm = data_patch(false, &[bin], "").unwrap();
        assert_eq!(cm, json!({"binaryData": {"bin": "AAEC"}}));
    }

    #[test]
    fn patch_rejects_bad_input() {
        let err = |secret, c: DataChange| data_patch(secret, &[c], "").unwrap_err().to_string();
        assert!(err(true, change("a b", "x", DataEncoding::Text)).contains("has ' '"));
        assert!(err(true, change("", "x", DataEncoding::Text)).contains("empty"));
        assert!(err(true, change("k", "not base64!", DataEncoding::Base64)).contains("base64"));
        assert!(err(false, change("k", "AA==", DataEncoding::Base64)).contains("text key"));
        assert!(data_patch(true, &[], "").is_err());
        let twice = [
            change("k", "1", DataEncoding::Text),
            change("k", "2", DataEncoding::Text),
        ];
        assert!(data_patch(true, &twice, "").is_err());
    }

    #[test]
    fn scrub_removes_values() {
        let changes = [change("password", "hunter2", DataEncoding::Text)];
        let got = scrub(
            "invalid value \"hunter2\" (aHVudGVyMg==) for password",
            &changes,
        );
        assert_eq!(got, "invalid value \"[hidden]\" ([hidden]) for password");
    }
}
