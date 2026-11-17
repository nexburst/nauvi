//! One-click metrics (#225): install metrics-server, or a small Prometheus
//! stack (Prometheus, kube-state-metrics and node-exporter), when a cluster
//! has none, through the same `helm install` as any chart (dry run first).
//!
//! Only the charts named here, from their projects' own repositories and
//! pinned to an exact chart version. The repository is passed to helm with
//! `--repo` and is never added to the user's helm configuration; the
//! frontend names an add-on by its id and cannot choose another chart,
//! repository or version. The values start from the small defaults below,
//! which the user sees and edits before the dry run.

use super::deploy::helm_install_from_repo;
use super::{HelmDeployRequest, HelmDeployResult, HelmStorage, HelmTarget};
use crate::action_access::{denied_reason, ActionAccess, Permission};
use crate::resources::can_i;
use anyhow::{anyhow, bail, Result};
use kube::Client;
use serde::{Deserialize, Serialize};

/// The add-ons nauvi offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum MetricsAddonId {
    MetricsServer,
    Prometheus,
}

impl MetricsAddonId {
    pub fn as_str(self) -> &'static str {
        match self {
            MetricsAddonId::MetricsServer => "metrics-server",
            MetricsAddonId::Prometheus => "prometheus",
        }
    }
}

/// A setting of an add-on that is off unless the user ticks it, shown as
/// its own checkbox (never applied silently).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MetricsAddonOption {
    pub id: String,
    pub label: String,
    /// What it does and when it is needed.
    pub detail: String,
    /// The container argument it adds to the chart's `args`.
    pub arg: String,
}

/// One add-on: what it installs, from where, and its starting values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MetricsAddon {
    pub id: MetricsAddonId,
    pub title: String,
    /// One sentence: what the app gets from it.
    pub summary: String,
    /// What runs in the cluster afterwards.
    pub components: Vec<String>,
    /// The chart repository (the project's own), as helm's `--repo`.
    pub repo_url: String,
    pub chart: String,
    /// The exact chart version installed.
    pub version: String,
    pub app_version: String,
    /// The suggested release name and namespace.
    pub release: String,
    pub namespace: String,
    /// The starting values (YAML), shown and editable.
    pub values: String,
    pub options: Vec<MetricsAddonOption>,
}

/// What the user chose for an add-on install (or its dry run).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MetricsAddonRequest {
    pub addon: MetricsAddonId,
    /// The release name.
    pub name: String,
    pub namespace: String,
    /// The edited values (YAML).
    pub values: String,
    /// Ids of the ticked [`MetricsAddonOption`]s.
    pub options: Vec<String>,
    pub create_namespace: bool,
    pub dry_run: bool,
    /// Show Secret values in the returned manifest.
    pub reveal: bool,
}

const METRICS_SERVER_REPO: &str = "https://kubernetes-sigs.github.io/metrics-server/";
const PROMETHEUS_REPO: &str = "https://prometheus-community.github.io/helm-charts";

/// The kind option: metrics-server checks each kubelet's serving
/// certificate, which kind (and other local clusters) sign themselves.
pub const KUBELET_INSECURE_TLS: &str = "kubelet-insecure-tls";

const METRICS_SERVER_VALUES: &str = "\
# Changes to the chart's defaults; everything else is as the chart sets it.
replicas: 1
resources:
  requests:
    cpu: 100m
    memory: 200Mi
";

const PROMETHEUS_VALUES: &str = "\
# A small Prometheus: the server, kube-state-metrics and node-exporter.
# Changes to the chart's defaults; everything else is as the chart sets it.
alertmanager:
  enabled: false
prometheus-pushgateway:
  enabled: false
kube-state-metrics:
  enabled: true
prometheus-node-exporter:
  enabled: true
server:
  retention: 7d
  persistentVolume:
    # No volume: the data is lost when the pod restarts. Set true (and a
    # size) to keep it on a cluster with a default StorageClass.
    enabled: false
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
";

/// Every add-on, metrics-server first.
pub fn metrics_addons() -> Vec<MetricsAddon> {
    [MetricsAddonId::MetricsServer, MetricsAddonId::Prometheus]
        .into_iter()
        .map(metrics_addon)
        .collect()
}

/// The add-on `id`.
pub fn metrics_addon(id: MetricsAddonId) -> MetricsAddon {
    let s = |v: &str| v.to_string();
    match id {
        MetricsAddonId::MetricsServer => MetricsAddon {
            id,
            title: s("metrics-server"),
            summary: s(
                "Live CPU and memory of pods and nodes: the usage columns, the overview's \
                        usage bars and kubectl top.",
            ),
            components: vec![s(
                "metrics-server (a Deployment and the metrics.k8s.io API)",
            )],
            repo_url: s(METRICS_SERVER_REPO),
            chart: s("metrics-server"),
            version: s("3.14.0"),
            app_version: s("0.9.0"),
            release: s("metrics-server"),
            namespace: s("kube-system"),
            values: s(METRICS_SERVER_VALUES),
            options: vec![MetricsAddonOption {
                id: s(KUBELET_INSECURE_TLS),
                label: s("Skip kubelet TLS verification (--kubelet-insecure-tls)"),
                detail: s(
                    "Needed on kind, minikube and other clusters whose kubelets have \
                           self-signed certificates. metrics-server then trusts any kubelet \
                           certificate; leave it off on other clusters.",
                ),
                arg: s("--kubelet-insecure-tls"),
            }],
        },
        MetricsAddonId::Prometheus => MetricsAddon {
            id,
            title: s("Prometheus"),
            summary: s("Usage history (1h, 6h, 24h) in the charts and a Disk column on Nodes."),
            components: vec![
                s("Prometheus server"),
                s("kube-state-metrics"),
                s("node-exporter (a DaemonSet on every node)"),
            ],
            repo_url: s(PROMETHEUS_REPO),
            chart: s("prometheus"),
            version: s("29.47.2"),
            app_version: s("v3.16.0"),
            release: s("prometheus"),
            namespace: s("monitoring"),
            values: s(PROMETHEUS_VALUES),
            options: Vec::new(),
        },
    }
}

/// The values helm gets: the user's, with the ticked options' arguments
/// added to `args` (created if missing). Unchanged without options.
pub fn values_with_options(
    addon: &MetricsAddon,
    values: &str,
    options: &[String],
) -> Result<String> {
    let mut args = Vec::new();
    for id in options {
        let opt = addon
            .options
            .iter()
            .find(|o| &o.id == id)
            .ok_or_else(|| anyhow!("{} has no option {id:?}", addon.title))?;
        args.push(opt.arg.clone());
    }
    if args.is_empty() {
        return Ok(values.to_string());
    }
    let mut doc: serde_yaml::Value = if values.trim().is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(values).map_err(|e| anyhow!("The values are not valid YAML: {e}"))?
    };
    if doc.is_null() {
        doc = serde_yaml::Value::Mapping(Default::default());
    }
    let map = doc
        .as_mapping_mut()
        .ok_or_else(|| anyhow!("The values must be a YAML mapping (key: value)"))?;
    let list = map
        .entry("args".into())
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()));
    if list.is_null() {
        *list = serde_yaml::Value::Sequence(Vec::new());
    }
    let seq = list.as_sequence_mut().ok_or_else(|| {
        anyhow!(
            "args in the values must be a list to add {}",
            args.join(" ")
        )
    })?;
    for arg in args {
        let v = serde_yaml::Value::String(arg);
        if !seq.contains(&v) {
            seq.push(v);
        }
    }
    Ok(serde_yaml::to_string(&doc)?)
}

/// The `helm install` request for `req`: the add-on's chart and version,
/// the user's release name, namespace and values (with the options).
pub fn addon_deploy_request(req: &MetricsAddonRequest) -> Result<HelmDeployRequest> {
    let addon = metrics_addon(req.addon);
    let values = values_with_options(&addon, &req.values, &req.options)?;
    Ok(HelmDeployRequest {
        name: req.name.trim().to_string(),
        namespace: req.namespace.trim().to_string(),
        chart: addon.chart,
        version: addon.version,
        values,
        create_namespace: req.create_namespace,
        dry_run: req.dry_run,
        reveal: req.reveal,
        storage: HelmStorage::Secret,
    })
}

/// `helm install` (or its server-side dry run) of an add-on, with its chart
/// from its own repository.
pub async fn install_metrics_addon(
    target: &HelmTarget,
    req: &MetricsAddonRequest,
) -> Result<HelmDeployResult> {
    let addon = metrics_addon(req.addon);
    let deploy = addon_deploy_request(req)?;
    helm_install_from_repo(target, &deploy, &addon.repo_url).await
}

fn perm(verb: &'static str, group: &str, resource: &str, ns: Option<&str>) -> Permission {
    Permission {
        verb,
        group: group.to_string(),
        resource: resource.to_string(),
        subresource: "",
        namespace: ns.map(str::to_string),
    }
}

/// What installing `addon` into `namespace` creates, cluster-scoped objects
/// first (the reason most users cannot install these).
pub fn addon_permissions(addon: MetricsAddonId, namespace: &str) -> Vec<Permission> {
    let rbac = "rbac.authorization.k8s.io";
    let ns = Some(namespace);
    let mut out = vec![
        perm("create", rbac, "clusterroles", None),
        perm("create", rbac, "clusterrolebindings", None),
    ];
    if addon == MetricsAddonId::MetricsServer {
        out.push(perm(
            "create",
            "apiregistration.k8s.io",
            "apiservices",
            None,
        ));
        // Read access to the API server's client CA, always in kube-system.
        out.push(perm("create", rbac, "rolebindings", Some("kube-system")));
    }
    out.extend([
        perm("create", "apps", "deployments", ns),
        perm("create", "", "services", ns),
        perm("create", "", "serviceaccounts", ns),
        // Where helm keeps the release.
        perm("create", "", "secrets", ns),
    ]);
    if addon == MetricsAddonId::Prometheus {
        out.extend([
            perm("create", "apps", "daemonsets", ns),
            perm("create", "", "configmaps", ns),
        ]);
    }
    out
}

/// Whether the user may install `addon` into `namespace`; the reason names
/// the first object RBAC refuses. A check that cannot be made counts as
/// allowed: the dry run still asks the API server.
pub async fn metrics_addon_access(
    client: &Client,
    addon: MetricsAddonId,
    namespace: &str,
) -> Result<ActionAccess> {
    let namespace = namespace.trim();
    if namespace.is_empty() {
        bail!("Choose a namespace first");
    }
    let perms = addon_permissions(addon, namespace);
    let answers = futures::future::join_all(perms.iter().map(|p| {
        can_i(
            client,
            p.verb,
            &p.group,
            &p.resource,
            p.subresource,
            p.namespace.as_deref(),
        )
    }))
    .await;
    let denied = perms
        .iter()
        .zip(answers)
        .find(|(_, ok)| !ok)
        .map(|(p, _)| p);
    Ok(ActionAccess {
        id: addon.as_str().to_string(),
        allowed: denied.is_none(),
        reason: denied.map(denied_reason).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(addon: MetricsAddonId) -> MetricsAddonRequest {
        let a = metrics_addon(addon);
        MetricsAddonRequest {
            addon,
            name: a.release,
            namespace: a.namespace,
            values: a.values,
            options: Vec::new(),
            create_namespace: true,
            dry_run: true,
            reveal: false,
        }
    }

    #[test]
    fn charts_are_pinned_and_from_their_projects() {
        for a in metrics_addons() {
            assert!(a.repo_url.starts_with("https://"), "{}", a.repo_url);
            assert!(
                a.version.split('.').count() == 3
                    && a.version.chars().all(|c| c.is_ascii_digit() || c == '.'),
                "{} is not an exact version",
                a.version
            );
            assert!(serde_yaml::from_str::<serde_yaml::Mapping>(&a.values).is_ok());
        }
        let ms = metrics_addon(MetricsAddonId::MetricsServer);
        assert_eq!(
            ms.repo_url,
            "https://kubernetes-sigs.github.io/metrics-server/"
        );
        assert_eq!(ms.namespace, "kube-system");
        let prom = metrics_addon(MetricsAddonId::Prometheus);
        assert_eq!(
            prom.repo_url,
            "https://prometheus-community.github.io/helm-charts"
        );
        assert_eq!(prom.namespace, "monitoring");
        // The release name makes the Service `prometheus-server`, which the
        // detection knows.
        assert_eq!(format!("{}-server", prom.release), "prometheus-server");
        assert!(crate::PROMETHEUS_SERVICE_NAMES.contains(&"prometheus-server"));
    }

    #[test]
    fn the_request_uses_the_addons_chart_and_version() {
        let mut r = req(MetricsAddonId::Prometheus);
        r.name = " my-prom ".into();
        let d = addon_deploy_request(&r).unwrap();
        assert_eq!(
            (d.name.as_str(), d.chart.as_str(), d.version.as_str()),
            ("my-prom", "prometheus", "29.47.2")
        );
        assert_eq!(d.values, r.values, "no options: values as typed");
        assert!(d.dry_run && d.create_namespace);
    }

    #[test]
    fn the_kind_option_adds_one_argument() {
        let addon = metrics_addon(MetricsAddonId::MetricsServer);
        let opts = vec![KUBELET_INSECURE_TLS.to_string()];
        let v = values_with_options(&addon, &addon.values, &opts).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&v).unwrap();
        assert_eq!(doc["args"][0], "--kubelet-insecure-tls");
        assert_eq!(doc["replicas"], 1);
        // Kept, and not twice.
        let v =
            values_with_options(&addon, "args: [--v=2, --kubelet-insecure-tls]\n", &opts).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&v).unwrap();
        assert_eq!(doc["args"].as_sequence().unwrap().len(), 2);
        assert_eq!(
            serde_yaml::from_str::<serde_yaml::Value>(
                &values_with_options(&addon, "", &opts).unwrap()
            )
            .unwrap()["args"][0],
            "--kubelet-insecure-tls"
        );
        assert!(values_with_options(&addon, "args: nope\n", &opts).is_err());
        assert!(values_with_options(&addon, "- a\n", &opts).is_err());
        // Only the add-on's own options.
        let prom = metrics_addon(MetricsAddonId::Prometheus);
        assert!(values_with_options(&prom, "", &opts).is_err());
        assert!(values_with_options(&addon, "", &["--set".into()]).is_err());
    }

    #[test]
    fn permissions_start_with_cluster_scoped_objects() {
        let p = addon_permissions(MetricsAddonId::MetricsServer, "kube-system");
        assert_eq!(
            p[0].describe(),
            "create clusterroles.rbac.authorization.k8s.io"
        );
        assert!(p
            .iter()
            .any(|p| p.describe() == "create apiservices.apiregistration.k8s.io"));
        assert!(p
            .iter()
            .any(|p| p.describe() == "create secrets in namespace kube-system"));
        let p = addon_permissions(MetricsAddonId::Prometheus, "monitoring");
        assert!(p
            .iter()
            .any(|p| p.describe() == "create daemonsets.apps in namespace monitoring"));
        assert!(!p.iter().any(|p| p.resource == "apiservices"));
    }

    #[tokio::test]
    async fn rejects_bad_input_before_running_helm() {
        let t = HelmTarget::default();
        let mut r = req(MetricsAddonId::MetricsServer);
        r.name = "-x".into();
        assert!(install_metrics_addon(&t, &r).await.is_err());
        let mut r = req(MetricsAddonId::MetricsServer);
        r.namespace = "--all".into();
        assert!(install_metrics_addon(&t, &r).await.is_err());
        let mut r = req(MetricsAddonId::MetricsServer);
        r.options = vec!["--post-renderer=x".into()];
        assert!(install_metrics_addon(&t, &r).await.is_err());
    }
}
