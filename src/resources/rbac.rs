//! What Roles, ClusterRoles, their bindings and ServiceAccounts say: table
//! cells, the detail panel's groups computed from the object alone, and
//! which bindings point at a role or an account. Pure functions of the
//! objects; [`super::related`] does the listing.

use super::columns::abbreviate;
use super::jsonpath::{array_at, cell_text, path_str};
use super::related::{RelatedGroup, RelatedItem};
use super::related_local::str_at;
use serde_json::Value;

pub(super) const RBAC_V1: &str = "rbac.authorization.k8s.io/v1";

// --- Columns -------------------------------------------------------------------

/// `ClusterRole/admin`.
pub(super) fn role_ref(binding: &Value) -> String {
    let name = path_str(binding, ".roleRef.name");
    if name.is_empty() {
        return String::new();
    }
    format!("{}/{name}", path_str(binding, ".roleRef.kind"))
}

/// The namespace of a ServiceAccount subject: its own, else the binding's.
fn subject_namespace(subject: &Value, binding: &Value) -> String {
    let ns = str_at(subject, "/namespace");
    if ns.is_empty() {
        str_at(binding, "/metadata/namespace")
    } else {
        ns
    }
}

/// `ServiceAccount:demo/web`, `User:alice`, `Group:devs`.
fn subject_text(subject: &Value, binding: &Value) -> String {
    let kind = str_at(subject, "/kind");
    let name = str_at(subject, "/name");
    if kind == "ServiceAccount" {
        format!("{kind}:{}/{name}", subject_namespace(subject, binding))
    } else {
        format!("{kind}:{name}")
    }
}

/// The subjects of a binding, at most three then "+N more".
pub(super) fn subjects(binding: &Value) -> String {
    abbreviate(
        array_at(binding, "/subjects")
            .map(|s| subject_text(s, binding))
            .collect(),
    )
}

// --- Bindings pointing at things ----------------------------------------------------

/// Whether `binding` grants the role `kind`/`name` (`Role` or `ClusterRole`).
pub(super) fn binds_role(binding: &Value, kind: &str, name: &str) -> bool {
    path_str(binding, ".roleRef.kind") == kind && path_str(binding, ".roleRef.name") == name
}

/// Whether `binding` has the ServiceAccount `namespace`/`name` as a subject.
pub(super) fn binds_account(binding: &Value, namespace: &str, name: &str) -> bool {
    array_at(binding, "/subjects").any(|s| {
        str_at(s, "/kind") == "ServiceAccount"
            && str_at(s, "/name") == name
            && subject_namespace(s, binding) == namespace
    })
}

/// Row of a RoleBinding or ClusterRoleBinding in a related group.
pub(super) fn binding_cells(v: &Value) -> Vec<String> {
    vec![str_at(v, "/metadata/name"), role_ref(v), subjects(v)]
}

/// The ServiceAccount a pod runs as (`default` when unset).
pub(super) fn pod_account(pod: &Value) -> String {
    let sa = str_at(pod, "/spec/serviceAccountName");
    if sa.is_empty() {
        "default".into()
    } else {
        sa
    }
}

// --- Groups from the object alone ---------------------------------------------------

fn list_text(v: &Value, pointer: &str, empty: &str) -> String {
    let items: Vec<String> = array_at(v, pointer).map(cell_text).collect();
    if items.is_empty() {
        empty.into()
    } else {
        items.join(", ")
    }
}

/// A Role's or ClusterRole's rules, one row each, like `kubectl describe`.
/// The core API group shows as `core`; Non-resource URLs only appear when
/// a rule has some.
pub(super) fn rules(v: &Value) -> Vec<RelatedGroup> {
    let all: Vec<&Value> = array_at(v, "/rules").collect();
    let urls = all
        .iter()
        .any(|r| array_at(r, "/nonResourceURLs").next().is_some());
    let rows = all
        .iter()
        .map(|r| {
            let groups: Vec<String> = array_at(r, "/apiGroups")
                .map(|g| match g.as_str() {
                    Some("") => "core".to_string(),
                    _ => cell_text(g),
                })
                .collect();
            let mut row = vec![
                groups.join(", "),
                list_text(r, "/resources", ""),
                list_text(r, "/resourceNames", "all"),
            ];
            if urls {
                row.push(list_text(r, "/nonResourceURLs", ""));
            }
            row.push(list_text(r, "/verbs", ""));
            row
        })
        .collect();
    let mut columns = vec!["API groups", "Resources", "Resource names"];
    if urls {
        columns.push("Non-resource URLs");
    }
    columns.push("Verbs");
    let mut groups = vec![RelatedGroup::plain("Rules", &columns, rows)];
    // An aggregated ClusterRole's rules are filled in from other roles.
    let selectors: Vec<Vec<String>> = array_at(v, "/aggregationRule/clusterRoleSelectors")
        .map(|s| {
            let labels = s
                .get("matchLabels")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(k, v)| format!("{k}={}", cell_text(v)))
                .collect::<Vec<_>>()
                .join(",");
            vec![labels]
        })
        .collect();
    if !selectors.is_empty() {
        groups.push(RelatedGroup::plain(
            "Aggregated from ClusterRoles matching",
            &["Labels"],
            selectors,
        ));
    }
    groups
}

/// The role a binding grants (a link) and its subjects: ServiceAccounts as
/// links, users and groups as plain rows.
pub(super) fn binding_refs(v: &Value) -> Vec<RelatedGroup> {
    let mut groups = Vec::new();
    let name = path_str(v, ".roleRef.name");
    if !name.is_empty() {
        let kind = path_str(v, ".roleRef.kind");
        // A RoleBinding's Role is in its namespace; a ClusterRole has none.
        let ns = if kind == "Role" {
            str_at(v, "/metadata/namespace")
        } else {
            String::new()
        };
        groups.push(RelatedGroup::objects(
            "Role",
            RBAC_V1,
            &kind,
            &["Name", "Kind"],
            vec![RelatedItem::object(
                &ns,
                &name,
                vec![name.clone(), kind.clone()],
            )],
        ));
    }
    let (accounts, others): (Vec<&Value>, Vec<&Value>) =
        array_at(v, "/subjects").partition(|s| str_at(s, "/kind") == "ServiceAccount");
    if !accounts.is_empty() || others.is_empty() {
        let items = accounts
            .iter()
            .map(|s| {
                let ns = subject_namespace(s, v);
                let name = str_at(s, "/name");
                RelatedItem::object(&ns, &name, vec![name.clone(), ns.clone()])
            })
            .collect();
        groups.push(RelatedGroup::objects(
            "Service accounts",
            "v1",
            "ServiceAccount",
            &["Name", "Namespace"],
            items,
        ));
    }
    if !others.is_empty() {
        let rows = others
            .iter()
            .map(|s| vec![str_at(s, "/kind"), str_at(s, "/name")])
            .collect();
        groups.push(RelatedGroup::plain(
            "Users and groups",
            &["Kind", "Name"],
            rows,
        ));
    }
    groups
}

/// The Secrets a ServiceAccount lists: legacy token secrets and image pull
/// secrets.
pub(super) fn account_secrets(v: &Value) -> Vec<RelatedGroup> {
    let ns = str_at(v, "/metadata/namespace");
    let mut items: Vec<RelatedItem> = Vec::new();
    for (pointer, how) in [("/secrets", "token"), ("/imagePullSecrets", "image pull")] {
        for s in array_at(v, pointer) {
            let name = str_at(s, "/name");
            if !name.is_empty() {
                items.push(RelatedItem::object(
                    &ns,
                    &name,
                    vec![name.clone(), how.into()],
                ));
            }
        }
    }
    if items.is_empty() {
        return Vec::new();
    }
    vec![RelatedGroup::objects(
        "Secrets",
        "v1",
        "Secret",
        &["Name", "Used as"],
        items,
    )]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding() -> Value {
        json!({
            "metadata": {"name": "web-read", "namespace": "demo"},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "reader"},
            "subjects": [
                {"kind": "ServiceAccount", "name": "web"},
                {"kind": "ServiceAccount", "name": "ci", "namespace": "tools"},
                {"kind": "User", "name": "alice"},
                {"kind": "Group", "name": "devs"}
            ]
        })
    }

    #[test]
    fn binding_columns() {
        let b = binding();
        assert_eq!(role_ref(&b), "Role/reader");
        assert_eq!(
            subjects(&b),
            "ServiceAccount:demo/web,ServiceAccount:tools/ci,User:alice +1 more"
        );
        assert_eq!(role_ref(&json!({})), "");
        assert_eq!(subjects(&json!({})), "");
        assert_eq!(
            binding_cells(&b),
            ["web-read", "Role/reader", subjects(&b).as_str()]
        );
    }

    #[test]
    fn which_bindings_point_where() {
        let b = binding();
        assert!(binds_role(&b, "Role", "reader"));
        assert!(!binds_role(&b, "ClusterRole", "reader"));
        assert!(binds_account(&b, "demo", "web"));
        assert!(binds_account(&b, "tools", "ci"));
        // The subject's namespace defaults to the binding's, nothing else.
        assert!(!binds_account(&b, "tools", "web"));
        assert!(!binds_account(&b, "demo", "alice"));
    }

    #[test]
    fn binding_groups_link_role_and_accounts() {
        let groups = binding_refs(&binding());
        let titles: Vec<_> = groups.iter().map(|g| g.title.as_str()).collect();
        assert_eq!(titles, ["Role", "Service accounts", "Users and groups"]);
        assert_eq!(
            (groups[0].api_version.as_str(), groups[0].kind.as_str()),
            (RBAC_V1, "Role")
        );
        assert_eq!(groups[0].items[0].namespace, "demo");
        let sa: Vec<_> = groups[1]
            .items
            .iter()
            .map(|i| (i.namespace.as_str(), i.name.as_str()))
            .collect();
        assert_eq!(sa, [("demo", "web"), ("tools", "ci")]);
        assert_eq!(groups[2].items[1].cells, ["Group", "devs"]);

        // A ClusterRoleBinding to a ClusterRole: no namespace on the link.
        let crb = json!({
            "metadata": {"name": "admins"},
            "roleRef": {"kind": "ClusterRole", "name": "cluster-admin"},
            "subjects": [{"kind": "Group", "name": "system:masters"}]
        });
        let groups = binding_refs(&crb);
        assert_eq!(groups[0].kind, "ClusterRole");
        assert_eq!(groups[0].items[0].namespace, "");
        // Only users/groups: no empty Service accounts group.
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[1].title, "Users and groups");
    }

    #[test]
    fn rules_table() {
        let role = json!({"rules": [
            {"apiGroups": [""], "resources": ["pods", "pods/log"], "verbs": ["get", "list"]},
            {"apiGroups": ["apps"], "resources": ["deployments"], "resourceNames": ["web"], "verbs": ["patch"]}
        ]});
        let g = &rules(&role)[0];
        assert_eq!(
            g.columns,
            ["API groups", "Resources", "Resource names", "Verbs"]
        );
        assert_eq!(
            g.items[0].cells,
            ["core", "pods, pods/log", "all", "get, list"]
        );
        assert_eq!(g.items[1].cells, ["apps", "deployments", "web", "patch"]);

        let cluster = json!({
            "rules": [{"nonResourceURLs": ["/healthz"], "verbs": ["get"]}],
            "aggregationRule": {"clusterRoleSelectors": [
                {"matchLabels": {"rbac.example.com/aggregate-to-view": "true"}}
            ]}
        });
        let groups = rules(&cluster);
        assert_eq!(groups[0].columns[3], "Non-resource URLs");
        assert_eq!(groups[0].items[0].cells, ["", "", "all", "/healthz", "get"]);
        assert_eq!(
            groups[1].items[0].cells,
            ["rbac.example.com/aggregate-to-view=true"]
        );
    }

    #[test]
    fn account_secrets_and_pod_account() {
        let sa = json!({
            "metadata": {"name": "web", "namespace": "demo"},
            "secrets": [{"name": "web-token"}],
            "imagePullSecrets": [{"name": "registry"}]
        });
        let g = &account_secrets(&sa)[0];
        assert_eq!(g.kind, "Secret");
        assert_eq!(g.items[1].cells, ["registry", "image pull"]);
        assert_eq!(g.items[1].namespace, "demo");
        assert!(account_secrets(&json!({})).is_empty());

        assert_eq!(pod_account(&json!({"spec": {}})), "default");
        assert_eq!(
            pod_account(&json!({"spec": {"serviceAccountName": "web"}})),
            "web"
        );
    }
}
