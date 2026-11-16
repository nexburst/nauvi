//! The Secret / ConfigMap data editor (#224) against the kind cluster:
//! keys without values, one value revealed, and a merge patch of only the
//! changed keys with the resourceVersion check. `#[ignore]`d like the other
//! cluster tests; each test uses its own temporary namespace.

use std::future::Future;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Secret};
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use kubeloupe::client_for_context;
use kubeloupe::resources::{
    get_data_entries, patch_data, reveal_data_value, ApplyOutcome, DataChange, DataEncoding,
    DataField, ResourceRef,
};

async fn connect() -> Result<Client> {
    let ctx = std::env::var("KUBELOUPE_TEST_CONTEXT")
        .unwrap_or_else(|_| "kind-kubeloupe-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let suffix = std::process::id() ^ chrono::Utc::now().timestamp_subsec_micros();
    let ns = format!("{prefix}-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(Duration::from_secs(90), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

fn core(kind: &str, plural: &str) -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced: true,
    }
}

fn change(key: &str, value: &str, encoding: DataEncoding) -> DataChange {
    DataChange {
        key: key.into(),
        field: DataField::Data,
        delete: false,
        value: value.into(),
        encoding,
    }
}

#[tokio::test]
#[ignore]
async fn secret_data_reveal_and_patch_only_changed_keys() -> Result<()> {
    in_temp_ns("kl-data", |client, ns| async move {
        let api: Api<Secret> = Api::namespaced(client.clone(), &ns);
        let secret: Secret = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "creds" },
            // "hunter2", one binary byte, and a key that must stay as it is.
            "data": { "password": "aHVudGVyMg==", "blob": "/w==", "keep": "a2VlcA==" }
        }))?;
        api.create(&PostParams::default(), &secret).await?;
        let r = core("Secret", "secrets");

        let entries = get_data_entries(&client, &r, &ns, "creds").await?;
        ensure!(entries.entries.len() == 3, "{entries:?}");
        ensure!(entries
            .entries
            .iter()
            .all(|e| e.hidden && e.value.is_empty()));
        let blob = entries.entries.iter().find(|e| e.key == "blob").unwrap();
        ensure!(blob.binary && blob.bytes == 1, "{blob:?}");

        let v = reveal_data_value(&client, &r, &ns, "creds", "password").await?;
        ensure!(v.value == "hunter2" && !v.binary, "{v:?}");
        let b = reveal_data_value(&client, &r, &ns, "creds", "blob").await?;
        ensure!(b.binary && b.value == "/w==", "{b:?}");

        // Change one key, remove another, add a third.
        let mut gone = change("blob", "", DataEncoding::Text);
        gone.delete = true;
        let changes = [
            change("password", "s3cret", DataEncoding::Text),
            gone,
            change("added", "AAEC", DataEncoding::Base64),
        ];
        let out = patch_data(
            &client,
            &r,
            &ns,
            "creds",
            &changes,
            &entries.resource_version,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        ensure!(matches!(out, ApplyOutcome::Applied { .. }), "{out:?}");
        let data = api.get("creds").await?.data.unwrap_or_default();
        let keys: Vec<_> = data.keys().cloned().collect();
        ensure!(keys == ["added", "keep", "password"], "{keys:?}");
        ensure!(data["password"].0 == b"s3cret");
        ensure!(data["keep"].0 == b"keep");
        ensure!(data["added"].0 == [0u8, 1, 2]);

        // The old resourceVersion is stale now: nothing is saved.
        let stale = patch_data(
            &client,
            &r,
            &ns,
            "creds",
            &[change("password", "other", DataEncoding::Text)],
            &entries.resource_version,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let ApplyOutcome::Conflict { resource_version } = stale else {
            anyhow::bail!("expected a conflict, got {stale:?}");
        };
        ensure!(resource_version != entries.resource_version);
        ensure!(api.get("creds").await?.data.unwrap_or_default()["password"].0 == b"s3cret");

        // An invalid key is refused, and the error never carries the value.
        let err = patch_data(
            &client,
            &r,
            &ns,
            "creds",
            &[change("bad key", "topsecretvalue", DataEncoding::Text)],
            "",
        )
        .await
        .unwrap_err();
        ensure!(!err.contains("topsecretvalue"), "{err}");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn configmap_data_and_binary_data_patch() -> Result<()> {
    in_temp_ns("kl-data", |client, ns| async move {
        let api: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);
        let cm: ConfigMap = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "settings" },
            "data": { "mode": "dev", "keep": "1" },
            "binaryData": { "bin": "AAEC" }
        }))?;
        api.create(&PostParams::default(), &cm).await?;
        let r = core("ConfigMap", "configmaps");

        let entries = get_data_entries(&client, &r, &ns, "settings").await?;
        let mode = entries.entries.iter().find(|e| e.key == "mode").unwrap();
        ensure!(mode.value == "dev" && !mode.hidden, "{mode:?}");
        let bin = entries.entries.iter().find(|e| e.key == "bin").unwrap();
        ensure!(bin.field == DataField::BinaryData && bin.binary && bin.bytes == 3);
        ensure!(reveal_data_value(&client, &r, &ns, "settings", "mode")
            .await
            .is_err());

        let mut bin_change = change("bin", "/w==", DataEncoding::Base64);
        bin_change.field = DataField::BinaryData;
        patch_data(
            &client,
            &r,
            &ns,
            "settings",
            &[change("mode", "prod", DataEncoding::Text), bin_change],
            &entries.resource_version,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let got = api.get("settings").await?;
        let data = got.data.unwrap_or_default();
        ensure!(data["mode"] == "prod" && data["keep"] == "1", "{data:?}");
        ensure!(got.binary_data.unwrap_or_default()["bin"].0 == [0xffu8]);

        // Immutable: reported, and the server refuses the change.
        let imm: ConfigMap = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "frozen" }, "immutable": true, "data": { "a": "1" }
        }))?;
        api.create(&PostParams::default(), &imm).await?;
        ensure!(
            get_data_entries(&client, &r, &ns, "frozen")
                .await?
                .immutable
        );
        let err = patch_data(
            &client,
            &r,
            &ns,
            "frozen",
            &[change("a", "2", DataEncoding::Text)],
            "",
        )
        .await
        .unwrap_err();
        ensure!(err.contains("immutable"), "{err}");
        Ok(())
    })
    .await
}
