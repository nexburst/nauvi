//! What a pod volume is, as one line of text for a container's mounts:
//! `secret db-creds`, `configmap app-cfg`, `pvc data`,
//! `projected (service account token)`, `emptyDir`.

use k8s_openapi::api::core::v1::{Volume, VolumeProjection};

/// The source of `v` in a few words. Names of Secrets and ConfigMaps only,
/// never their contents.
pub fn volume_source(v: &Volume) -> String {
    if let Some(s) = &v.secret {
        return format!("secret {}", s.secret_name.as_deref().unwrap_or(""))
            .trim_end()
            .to_string();
    }
    if let Some(c) = &v.config_map {
        return format!("configmap {}", c.name);
    }
    if let Some(p) = &v.persistent_volume_claim {
        return format!("pvc {}", p.claim_name);
    }
    if let Some(p) = &v.projected {
        return projected_text(p.sources.as_deref().unwrap_or(&[]));
    }
    if let Some(e) = &v.empty_dir {
        return match e.medium.as_deref() {
            Some(m) if !m.is_empty() => format!("emptyDir ({})", m.to_lowercase()),
            _ => "emptyDir".to_string(),
        };
    }
    if let Some(h) = &v.host_path {
        return format!("hostPath {}", h.path);
    }
    if v.downward_api.is_some() {
        return "downward API".to_string();
    }
    if let Some(c) = &v.csi {
        return format!("csi {}", c.driver);
    }
    if v.ephemeral.is_some() {
        return "ephemeral pvc".to_string();
    }
    if let Some(n) = &v.nfs {
        return format!("nfs {}:{}", n.server, n.path);
    }
    if let Some(i) = &v.image {
        return format!("image {}", i.reference.as_deref().unwrap_or(""))
            .trim_end()
            .to_string();
    }
    // Any other type (the in-tree cloud disks, iscsi, ...): its field name.
    serde_json::to_value(v)
        .ok()
        .and_then(|j| {
            j.as_object()
                .and_then(|o| o.keys().find(|k| *k != "name").cloned())
        })
        .unwrap_or_default()
}

/// `projected (service account token)` for the token volume every pod gets
/// (`kube-api-access-*`), else what it projects: `projected (secret a, configmap b)`.
fn projected_text(sources: &[VolumeProjection]) -> String {
    if sources.iter().any(|s| s.service_account_token.is_some()) {
        return "projected (service account token)".to_string();
    }
    let parts: Vec<String> = sources
        .iter()
        .filter_map(|s| {
            if let Some(x) = &s.secret {
                Some(format!("secret {}", x.name))
            } else if let Some(x) = &s.config_map {
                Some(format!("configmap {}", x.name))
            } else if s.downward_api.is_some() {
                Some("downward API".to_string())
            } else if s.cluster_trust_bundle.is_some() {
                Some("cluster trust bundle".to_string())
            } else {
                None
            }
        })
        .collect();
    if parts.is_empty() {
        "projected".to_string()
    } else {
        format!("projected ({})", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn src(v: serde_json::Value) -> String {
        volume_source(&serde_json::from_value(v).unwrap())
    }

    #[test]
    fn each_volume_type_reads_as_its_source() {
        assert_eq!(
            src(json!({ "name": "c", "secret": { "secretName": "db-creds" } })),
            "secret db-creds"
        );
        assert_eq!(
            src(json!({ "name": "c", "configMap": { "name": "app-cfg" } })),
            "configmap app-cfg"
        );
        assert_eq!(
            src(json!({ "name": "c", "persistentVolumeClaim": { "claimName": "data" } })),
            "pvc data"
        );
        assert_eq!(src(json!({ "name": "c", "emptyDir": {} })), "emptyDir");
        assert_eq!(
            src(json!({ "name": "c", "emptyDir": { "medium": "Memory" } })),
            "emptyDir (memory)"
        );
        assert_eq!(
            src(json!({ "name": "c", "hostPath": { "path": "/var/log" } })),
            "hostPath /var/log"
        );
        assert_eq!(
            src(json!({ "name": "c", "downwardAPI": { "items": [] } })),
            "downward API"
        );
        assert_eq!(
            src(json!({ "name": "c", "csi": { "driver": "secrets-store.csi.k8s.io" } })),
            "csi secrets-store.csi.k8s.io"
        );
        assert_eq!(
            src(json!({ "name": "c", "nfs": { "server": "10.0.0.2", "path": "/exports" } })),
            "nfs 10.0.0.2:/exports"
        );
        assert_eq!(
            src(json!({ "name": "c", "ephemeral": { "volumeClaimTemplate": { "spec": {} } } })),
            "ephemeral pvc"
        );
        assert_eq!(
            src(json!({ "name": "c", "image": { "reference": "quay.io/x/models:v1" } })),
            "image quay.io/x/models:v1"
        );
        // A type without its own text: the field name.
        assert_eq!(
            src(json!({ "name": "c", "iscsi": { "targetPortal": "t", "iqn": "i", "lun": 0 } })),
            "iscsi"
        );
    }

    #[test]
    fn projected_volumes_name_the_token_or_what_they_project() {
        // What the API server adds to every pod.
        assert_eq!(
            src(
                json!({ "name": "kube-api-access-abcde", "projected": { "sources": [
                { "serviceAccountToken": { "expirationSeconds": 3607, "path": "token" } },
                { "configMap": { "name": "kube-root-ca.crt", "items": [{ "key": "ca.crt", "path": "ca.crt" }] } },
                { "downwardAPI": { "items": [] } }
            ] } })
            ),
            "projected (service account token)"
        );
        assert_eq!(
            src(json!({ "name": "all", "projected": { "sources": [
                { "secret": { "name": "tls" } },
                { "configMap": { "name": "cfg" } }
            ] } })),
            "projected (secret tls, configmap cfg)"
        );
        assert_eq!(
            src(json!({ "name": "p", "projected": { "sources": [] } })),
            "projected"
        );
    }
}
