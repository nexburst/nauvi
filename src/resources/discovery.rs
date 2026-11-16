//! API discovery, access checks and resolving a kind by name.

use super::columns::{columns_for, spec_for, PrinterColumn, KINDS};
use super::*;
use anyhow::Result;
use futures::StreamExt;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

/// Used only when the CRD list itself cannot be read: groups that are not
/// part of the built-in API look like CRDs.
fn looks_custom(group: &str) -> bool {
    group.contains('.') && !group.ends_with(".k8s.io")
}

type PrinterColumns = HashMap<(String, String, String), Vec<PrinterColumn>>;

/// Printer columns of every CRD version, keyed by (group, plural, version).
/// `None` if the CRDs cannot be listed.
async fn crd_printer_columns(client: &Client) -> Option<PrinterColumns> {
    let api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let list = api.list(&ListParams::default()).await.ok()?;
    let mut out = HashMap::new();
    for crd in list.items {
        for v in &crd.spec.versions {
            let cols = v
                .additional_printer_columns
                .iter()
                .flatten()
                .map(|c| PrinterColumn {
                    name: c.name.clone(),
                    type_: c.type_.clone(),
                    json_path: c.json_path.clone(),
                    priority: c.priority.unwrap_or(0),
                })
                .collect();
            out.insert(
                (
                    crd.spec.group.clone(),
                    crd.spec.names.plural.clone(),
                    v.name.clone(),
                ),
                cols,
            );
        }
    }
    Some(out)
}

/// Ask the server what it serves: every kind of every group (at the group's
/// preferred version), including CRDs, with scope, verbs and columns.
///
/// This is a hand-rolled version of `kube::discovery::Discovery::run`, which
/// queries every version of every group and fails as a whole when a single
/// aggregated API (an unhealthy metrics-server, say) is down. Here a failing
/// group is skipped, as `kubectl` does.
pub async fn discover(client: &Client) -> Result<Vec<ResourceKind>> {
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList;

    let groups = client.list_api_groups().await?.groups;
    let mut wanted: Vec<(bool, String)> = groups
        .iter()
        .filter_map(|g| {
            let v = g
                .preferred_version
                .as_ref()
                .or_else(|| g.versions.first())?;
            Some((false, v.group_version.clone()))
        })
        .collect();
    wanted.push((true, "v1".to_string()));

    let lists: Vec<Option<APIResourceList>> = futures::stream::iter(wanted)
        .map(|(core, gv)| {
            let client = client.clone();
            async move {
                let res = if core {
                    client.list_core_api_resources(&gv).await
                } else {
                    client.list_api_group_resources(&gv).await
                };
                match res {
                    Ok(l) => Some(l),
                    Err(e) => {
                        tracing::warn!(
                            "discovery of {gv} failed: {}",
                            crate::errors::chain_text(&e)
                        );
                        None
                    }
                }
            }
        })
        .buffer_unordered(16)
        .collect()
        .await;

    let printer = crd_printer_columns(client).await;
    let crd_set: Option<HashSet<(String, String)>> = printer.as_ref().map(|m| {
        m.keys()
            .map(|(g, p, _)| (g.clone(), p.clone()))
            .collect::<HashSet<_>>()
    });

    let mut kinds = Vec::new();
    for list in lists.into_iter().flatten() {
        let (group, version) = match list.group_version.split_once('/') {
            Some((g, v)) => (g.to_string(), v.to_string()),
            None => (String::new(), list.group_version.clone()),
        };
        // events.k8s.io duplicates the core Events.
        if group == "events.k8s.io" {
            continue;
        }
        for r in list.resources {
            if r.name.contains('/') || !r.verbs.iter().any(|v| v == "list") {
                continue;
            }
            let resource = ResourceRef {
                group: group.clone(),
                version: version.clone(),
                kind: r.kind.clone(),
                plural: r.name.clone(),
                namespaced: r.namespaced,
            };
            let spec = spec_for(&group, &r.kind);
            let crd = match &crd_set {
                Some(set) => set.contains(&(group.clone(), r.name.clone())),
                None => looks_custom(&group),
            };
            let printer_cols = printer
                .as_ref()
                .and_then(|m| m.get(&(group.clone(), r.name.clone(), version.clone())))
                .map(Vec::as_slice)
                .unwrap_or_default();
            kinds.push(ResourceKind {
                id: resource.id(),
                label: spec.map_or_else(|| kind_label(&r.kind, &r.name), |s| s.label.to_string()),
                category: match spec {
                    Some(s) => s.category,
                    None if crd => Category::Custom,
                    None => Category::Other,
                },
                crd,
                verbs: r.verbs.clone(),
                short_names: short_names_with_aliases(
                    &r.name,
                    r.short_names.clone().unwrap_or_default(),
                ),
                columns: columns_for(&resource, printer_cols),
                actions: crate::actions::actions_for(&resource, &r.verbs),
                resource,
            });
        }
    }
    // Registry kinds in registry order, then the rest by group and kind.
    let rank = |k: &ResourceKind| {
        KINDS
            .iter()
            .position(|s| s.group == k.resource.group && s.kind == k.resource.kind)
    };
    kinds.sort_by(|a, b| match (rank(a), rank(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => {
            (&a.resource.group, &a.resource.kind).cmp(&(&b.resource.group, &b.resource.kind))
        }
    });
    disambiguate_labels(&mut kinds);
    Ok(kinds)
}

/// A sidebar label for a kind that has no entry in the column registry: the
/// kind split into words, with its last word made plural the way the API's
/// plural spells it. `ComponentStatus`/`componentstatuses` -> "Component
/// Statuses", `CSIStorageCapacity`/`csistoragecapacities` -> "CSI Storage
/// Capacities". A kind whose plural is not the kind plus an ending
/// (`NodeMetrics`/`nodes`) keeps the kind's own words: "Node Metrics".
fn kind_label(kind: &str, plural: &str) -> String {
    if kind.is_empty() {
        return plural.to_string();
    }
    let lower = kind.to_lowercase();
    // The ASCII prefix the kind and the plural share.
    let common = lower
        .bytes()
        .zip(plural.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let dropped = lower.len() - common;
    if kind.is_ascii() && plural.is_ascii() && dropped <= 1 && common > 0 {
        // `Status` + "es", `Policy` -> `Polic` + "ies", `Endpoints` + "".
        // Split before adding the ending, so `ServiceCIDR` + "s" stays one word.
        format!("{}{}", split_words(&kind[..common]), &plural[common..])
    } else {
        split_words(kind)
    }
}

/// `ComponentStatuses` -> "Component Statuses", `CSIDrivers` -> "CSI
/// Drivers", `IPAddresses` -> "IP Addresses".
fn split_words(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            // A new word after a lowercase letter or digit, or the last
            // capital of an acronym when a lowercase letter follows.
            if prev.is_lowercase() || prev.is_ascii_digit() || (prev.is_uppercase() && next_lower) {
                out.push(' ');
            }
        }
        out.push(c);
    }
    let mut c = out.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// No two sidebar entries share a label: a kind (outside the registry)
/// whose label another kind already has gets its API group added, e.g. a
/// CRD named `Pod` in `example.com` becomes "Pods (example.com)". Kinds are
/// told apart by group, version and resource, never by label; registry
/// kinds come first and keep theirs.
fn disambiguate_labels(kinds: &mut [ResourceKind]) {
    let mut seen: HashMap<String, (String, String, String)> = HashMap::new();
    for k in kinds.iter_mut() {
        let id = (
            k.resource.group.clone(),
            k.resource.version.clone(),
            k.resource.plural.clone(),
        );
        if seen.get(&k.label).is_some_and(|other| *other != id) {
            let group = if k.resource.group.is_empty() {
                "core"
            } else {
                &k.resource.group
            };
            k.label = format!("{} ({group})", k.label);
        }
        seen.entry(k.label.clone()).or_insert(id);
    }
}

/// Whether the current user may `list` `resource` in `group`, in
/// `namespace` (`None` = across all namespaces, or a cluster-scoped kind),
/// via a SelfSubjectAccessReview. A check that cannot be made counts as
/// allowed, so a restrictive cluster never hides everything.
pub async fn can_list(
    client: &Client,
    group: &str,
    resource: &str,
    namespace: Option<&str>,
) -> bool {
    can_i(client, "list", group, resource, "", namespace).await
}

/// Whether the current user may `verb` `resource` (with `subresource`, empty
/// for none) in `group`, in `namespace` (`None` = across all namespaces, or
/// a cluster-scoped kind), via a SelfSubjectAccessReview. A check that
/// cannot be made counts as allowed: the API server still has the last word.
pub async fn can_i(
    client: &Client,
    verb: &str,
    group: &str,
    resource: &str,
    subresource: &str,
    namespace: Option<&str>,
) -> bool {
    let api: Api<SelfSubjectAccessReview> = Api::all(client.clone());
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some(verb.into()),
                group: Some(group.to_string()),
                resource: Some(resource.to_string()),
                subresource: (!subresource.is_empty()).then(|| subresource.to_string()),
                namespace: namespace.map(str::to_string),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    match api.create(&Default::default(), &review).await {
        Ok(res) => res.status.map(|s| s.allowed).unwrap_or(true),
        Err(_) => true,
    }
}

/// Which of `kinds` the current user may list in the given scope: in
/// `namespace` if one is given, otherwise across all namespaces. The
/// namespace is ignored for cluster-scoped kinds. A check that cannot be
/// made counts as allowed.
pub async fn check_access(
    client: &Client,
    kinds: &[ResourceRef],
    namespace: Option<&str>,
) -> Vec<AccessResult> {
    futures::stream::iter(kinds.iter().cloned())
        .map(|r| async move {
            let ns = if r.namespaced { namespace } else { None };
            let allowed = can_list(client, &r.group, &r.plural, ns).await;
            AccessResult {
                id: r.id(),
                allowed,
            }
        })
        .buffer_unordered(16)
        .collect()
        .await
}

/// Aliases kubectl users type that discovery does not always provide, as
/// (alias, plural).
const ALIASES: &[(&str, &str)] = &[
    ("po", "pods"),
    ("deploy", "deployments"),
    ("sts", "statefulsets"),
    ("ds", "daemonsets"),
    ("rs", "replicasets"),
    ("cj", "cronjobs"),
    ("svc", "services"),
    ("ing", "ingresses"),
    ("netpol", "networkpolicies"),
    ("cm", "configmaps"),
    ("hpa", "horizontalpodautoscalers"),
    ("quota", "resourcequotas"),
    ("pvc", "persistentvolumeclaims"),
    ("pv", "persistentvolumes"),
    ("sc", "storageclasses"),
    ("no", "nodes"),
    ("ns", "namespaces"),
    ("ev", "events"),
    ("ep", "endpoints"),
    ("sa", "serviceaccounts"),
    ("pdb", "poddisruptionbudgets"),
    ("pc", "priorityclasses"),
    ("crd", "customresourcedefinitions"),
    ("crds", "customresourcedefinitions"),
];

fn alias_of(name: &str) -> &str {
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == name)
        .map_or(name, |(_, plural)| plural)
}

/// The short names discovery reports plus the kubectl aliases of `plural`,
/// so the UI's command palette finds `deploy` and `svc` on any cluster.
fn short_names_with_aliases(plural: &str, mut short: Vec<String>) -> Vec<String> {
    for (alias, p) in ALIASES {
        if *p == plural && !short.iter().any(|s| s == alias) {
            short.push(alias.to_string());
        }
    }
    short
}

/// Find a kind by what a person types: plural, kind, short name, or
/// `plural.group`. Ambiguities resolve to the first match in sidebar order.
pub fn resolve_kind<'a>(kinds: &'a [ResourceKind], name: &str) -> Option<&'a ResourceKind> {
    let q = alias_of(&name.to_lowercase()).to_string();
    kinds.iter().find(|k| {
        let r = &k.resource;
        q == r.plural
            || q == r.kind.to_lowercase()
            || k.short_names.contains(&q)
            || (!r.group.is_empty() && q == format!("{}.{}", r.plural, r.group))
    })
}
#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn resolve_kind_by_plural_kind_alias_and_group() {
        let kinds = vec![
            kind("apps", "Deployment", "deployments", &["deploy"]),
            kind("example.com", "Widget", "widgets", &["wg"]),
        ];
        for q in ["deployments", "Deployment", "deploy", "DEPLOY"] {
            assert_eq!(resolve_kind(&kinds, q).unwrap().resource.kind, "Deployment");
        }
        assert_eq!(resolve_kind(&kinds, "wg").unwrap().resource.kind, "Widget");
        assert_eq!(
            resolve_kind(&kinds, "widgets.example.com")
                .unwrap()
                .resource
                .kind,
            "Widget"
        );
        assert!(resolve_kind(&kinds, "nope").is_none());
    }

    #[test]
    fn labels_come_from_the_kind_with_the_plural_ending() {
        for (kind, plural, label) in [
            ("ComponentStatus", "componentstatuses", "Component Statuses"),
            ("PodTemplate", "podtemplates", "Pod Templates"),
            (
                "ReplicationController",
                "replicationcontrollers",
                "Replication Controllers",
            ),
            (
                "MutatingAdmissionPolicy",
                "mutatingadmissionpolicies",
                "Mutating Admission Policies",
            ),
            (
                "MutatingAdmissionPolicyBinding",
                "mutatingadmissionpolicybindings",
                "Mutating Admission Policy Bindings",
            ),
            (
                "PriorityLevelConfiguration",
                "prioritylevelconfigurations",
                "Priority Level Configurations",
            ),
            (
                "VolumeAttributesClass",
                "volumeattributesclasses",
                "Volume Attributes Classes",
            ),
            (
                "CSIStorageCapacity",
                "csistoragecapacities",
                "CSI Storage Capacities",
            ),
            ("CSINode", "csinodes", "CSI Nodes"),
            ("IPAddress", "ipaddresses", "IP Addresses"),
            ("APIService", "apiservices", "API Services"),
            ("ServiceCIDR", "servicecidrs", "Service CIDRs"),
            ("NodeMetrics", "nodes", "Node Metrics"),
            ("PodMetrics", "pods", "Pod Metrics"),
            ("Endpoints", "endpoints", "Endpoints"),
            ("Gadget", "gadgets", "Gadgets"),
            ("Leaf", "leaves", "Leaves"),
            ("Foo", "bars", "Foo"),
            ("widget", "widgets", "Widgets"),
        ] {
            assert_eq!(kind_label(kind, plural), label, "{kind}/{plural}");
        }
    }

    #[test]
    fn same_labels_get_the_group_but_the_same_resource_does_not() {
        let mut kinds = vec![
            kind("", "Pod", "pods", &[]),
            kind("example.com", "Pod", "pods", &[]),
            kind("other.io", "Widget", "widgets", &[]),
        ];
        for k in &mut kinds {
            k.label = "Pods".into();
        }
        kinds[2].label = "Widgets".into();
        disambiguate_labels(&mut kinds);
        let labels: Vec<_> = kinds.iter().map(|k| k.label.as_str()).collect();
        assert_eq!(labels, ["Pods", "Pods (example.com)", "Widgets"]);
    }

    #[test]
    fn short_names_gain_the_kubectl_aliases_once() {
        assert_eq!(
            short_names_with_aliases("deployments", vec!["deploy".into()]),
            vec!["deploy"]
        );
        assert_eq!(
            short_names_with_aliases("networkpolicies", vec![]),
            vec!["netpol"]
        );
        assert!(short_names_with_aliases("widgets", vec![]).is_empty());
        assert_eq!(alias_of("svc"), "services");
        assert_eq!(alias_of("crds"), "customresourcedefinitions");
        assert_eq!(alias_of("sa"), "serviceaccounts");
        assert_eq!(alias_of("widgets"), "widgets");
    }
}
