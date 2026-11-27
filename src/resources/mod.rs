//! Generic resource access: API discovery, a declarative column registry and
//! list / get / YAML / apply / delete / watch on `DynamicObject`, keyed by a
//! [`ResourceRef`] (group, version, kind, plural, scope).
//!
//! Everything the UI and the CLI show for a kind other than a pod's rich
//! detail goes through here. Adding columns for a built-in kind is one entry
//! in `KINDS` (`columns.rs`); CRDs get Name / Namespace / Age plus the printer
//! columns the CRD declares (what `kubectl get` shows).
//!
//! - `columns`: the column registry and how a row's cells are filled
//! - `jsonpath`: the small JSONPath the columns are written in
//! - `discovery`: API discovery, access checks, resolving a kind by name
//! - `ops`: list / get / YAML get and apply / delete
//! - `manifests`, `apply`: create or update objects from a manifest file
//! - `detail`: the detail panel for any kind
//! - `pod_detail`: the pod section of the detail panel (containers, probes, ...);
//!   `volume_source` says what a mounted volume is, `mask` hides secret-looking
//!   values in command lines; `pod_env` resolves a container's env values
//! - `detail_watch`: live updates of one object's detail
//! - `related`: related objects and a per-kind summary (`related_local`,
//!   `related_summary`, `related_crd` hold the pure per-kind parts)
//! - `problems`: which rows need attention (row highlights, sidebar badges)
//! - `rbac`: what Roles, bindings and ServiceAccounts say (cells, rules,
//!   which bindings point at a role or an account)
//! - `dra`: cells of the Dynamic Resource Allocation kinds (claims, slices)
//! - `status`: the status of a workload object (overview counts, filters)
//! - `table`: `kubectl get`-style table output for the CLI

mod apply;
mod columns;
#[cfg(test)]
mod columns_cost;
mod custom_columns;
mod data;
mod detail;
mod detail_watch;
mod discovery;
mod dra;
mod image_column;
mod jsonpath;
mod manifests;
mod mask;
mod mask_json;
mod ops;
mod pod_containers;
mod pod_detail;
mod pod_env;
mod pod_printer;
mod problems;
mod rbac;
mod rebase;
mod related;
mod related_crd;
mod related_local;
mod related_summary;
mod secret_copy;
mod status;
mod table;
mod volume_source;
mod workload_status;

#[cfg(feature = "mcp")]
pub(crate) use apply::result_line;
pub use apply::{apply_manifests, cli_apply, ApplyResult, ApplyStatus, ManifestOptions};
pub use columns::make_row;
pub use custom_columns::{
    check_custom_column, check_field_path, custom_column_defs, custom_key, CustomColumn,
    CustomSource, MAX_CUSTOM_COLUMNS, MAX_CUSTOM_LABEL, MAX_CUSTOM_VALUE,
};
pub use data::{
    data_patch, entries_of, get_data_entries, patch_data, reveal_data_value, revealed_of, scrub,
    DataChange, DataEncoding, DataEntries, DataEntry, DataField, RevealedValue,
};
pub use detail::{detail_of, get_resource_detail, summarize_events};
pub use detail_watch::{run_detail_watch, DetailState, DETAIL_FLUSH};
pub use discovery::{can_i, can_i_answer, can_list, check_access, discover, resolve_kind};
pub use ops::{
    apply_resource_yaml, apply_resource_yaml_with, delete_resource, dyn_api, get_resource,
    get_resource_yaml, list_resources, object_value, to_yaml, ApplyOptions, ApplyOutcome,
    FieldTakeover,
};
pub use pod_detail::{
    env_refs, pod_extras, probe_summary, state_info, ContainerDetail, ContainerKind, EnvInfo,
    MountInfo, PodExtras, PortInfo, ProbeInfo, StateInfo,
};
pub use pod_env::{
    env_reveal_from, env_sources, field_value, get_pod_env, resolve_env, reveal_pod_env_value,
    ContainerEnv, EnvFromGroup, EnvSource, EnvSourceKind, EnvValue, RevealFrom,
};
pub use pod_printer::printed_pod_status;
pub use problems::{not_ready_reason, row_problem};
pub use related::{get_related, related_objects, Fact, Related, RelatedGroup, RelatedItem};
pub use secret_copy::secret_copy_keys;
pub use status::{classify, pod_status_of, statuses_of, WorkloadStatus, STARTING, WORKLOAD_KINDS};
pub use table::{align_columns, render_table, table_cells, table_header};

use columns::Source;
use kube::api::ApiResource;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Placeholder shown instead of Secret values until the user reveals them.
pub const REDACTED: &str = "<hidden: reveal to view>";

// ---------------------------------------------------------------------------
// Types shared with the UI.
// ---------------------------------------------------------------------------

/// Identifies a resource type well enough to build an `Api<DynamicObject>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ResourceRef {
    /// API group; empty for the core group.
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

impl ResourceRef {
    pub fn api_resource(&self) -> ApiResource {
        ApiResource {
            group: self.group.clone(),
            version: self.version.clone(),
            api_version: if self.group.is_empty() {
                self.version.clone()
            } else {
                format!("{}/{}", self.group, self.version)
            },
            kind: self.kind.clone(),
            plural: self.plural.clone(),
        }
    }

    /// Stable id: `v1/pods`, `apps/v1/deployments`.
    pub fn id(&self) -> String {
        if self.group.is_empty() {
            format!("{}/{}", self.version, self.plural)
        } else {
            format!("{}/{}/{}", self.group, self.version, self.plural)
        }
    }

    fn is(&self, group: &str, kind: &str) -> bool {
        self.group == group && self.kind == kind
    }
}

/// Where a kind appears in the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Workloads,
    Network,
    Config,
    Storage,
    Cluster,
    /// RBAC: ServiceAccounts, Roles, ClusterRoles and their bindings.
    Access,
    /// Dynamic Resource Allocation: DeviceClasses, ResourceClaims, ...
    Devices,
    /// CRDs, grouped by API group; the CRDs themselves are "Definitions".
    Custom,
    /// Anything else the server serves (apiservices, flowschemas, ...).
    Other,
}

/// How a column's cell is produced and rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ColumnKind {
    Text,
    /// Sorted numerically.
    Number,
    /// Derived from the creation time by the UI, so it stays fresh.
    Age,
    /// Coloured by value (Running, Pending, Failed, ...).
    Status,
    /// Live usage merged in by the UI from the metrics API.
    PodCpu,
    PodMemory,
    NodeCpu,
    NodeMemory,
    /// A node's root filesystem, from Prometheus (node-exporter).
    NodeDisk,
    /// The controller of the object: `Kind/name`, or `Kind.group/name`
    /// outside the core, `apps` and `batch` groups. The UI links it to the
    /// owner's detail.
    Owner,
    /// A pod's containers and their states (`init:setup=done app=ready`,
    /// see `pod_containers`), drawn by the UI as one square each.
    Containers,
    /// What a Deployment, StatefulSet or DaemonSet controller is doing
    /// (`Running`, `Scaling`, `Updating`, `Failed`, ... see
    /// `workload_status`), drawn by the UI with a shape and a colour.
    Rollout,
    /// The images of a pod or a workload's pod template (#547): the first
    /// line is what the cell shows (`mongo:7.0.1 +1`), each line after it a
    /// full reference, for the tooltip (see `image_column`).
    Image,
    /// Image vulnerabilities (#535): filled by the UI from the image
    /// security listing it already holds, keyed by workload. Off by
    /// default, and not offered while image security is off.
    Vulns,
}

/// A table column as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ColumnDef {
    pub key: String,
    pub label: String,
    pub kind: ColumnKind,
    /// Off until the user turns it on in the column chooser (IP, QoS, ...);
    /// the CLI's tables leave it out.
    pub default_hidden: bool,
    #[serde(skip)]
    #[cfg_attr(feature = "specta", specta(skip))]
    source: Source,
}

/// One entry of the sidebar: a discovered resource type with its columns.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ResourceKind {
    pub resource: ResourceRef,
    /// [`ResourceRef::id`].
    pub id: String,
    /// Display name ("Deployments", "Network Policies").
    pub label: String,
    pub category: Category,
    /// Defined by a CustomResourceDefinition.
    pub crd: bool,
    pub verbs: Vec<String>,
    /// Short names from discovery plus kubectl's aliases (`deploy`, `svc`).
    pub short_names: Vec<String>,
    pub columns: Vec<ColumnDef>,
    /// What can be done to objects of this kind ([`crate::actions::actions_for`]).
    pub actions: Vec<crate::actions::ActionDef>,
}

/// A row of a resource table: identity plus one cell per column. Columns the
/// UI fills itself (age, metrics) have an empty cell.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ResourceRow {
    /// `namespace/name`, or `name` for cluster-scoped objects.
    pub key: String,
    pub name: String,
    pub namespace: String,
    /// Creation time (unix seconds).
    pub created: i64,
    pub cells: Vec<String>,
    /// The workload status the Workloads overview counts this object under
    /// ([`WorkloadStatus::as_str`]), so a click on a count can filter the
    /// table; "" for kinds that are not workloads.
    pub status: String,
    /// Why the object needs attention (`CrashLoopBackOff`, `1 of 3 ready`);
    /// empty if it is fine ([`problems::row_problem`]).
    pub problem: String,
}

/// Result of an access check for one kind.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AccessResult {
    pub id: String,
    pub allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct OwnerLink {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub controller: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConditionInfo {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: String,
    pub message: String,
    pub age: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RelatedEvent {
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub age: String,
    /// When it last happened (unix seconds, 0 if unknown), so the UI can
    /// say "last 41s ago" and keep it fresh.
    pub time: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SecretKey {
    pub key: String,
    /// Decoded size in bytes.
    pub bytes: u32,
}

/// Everything the detail panel shows besides the YAML.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ResourceDetail {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub api_version: String,
    pub kind: String,
    pub created: i64,
    pub age: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub finalizers: Vec<String>,
    pub owners: Vec<OwnerLink>,
    pub conditions: Vec<ConditionInfo>,
    /// Keys of a Secret's data (never the values).
    pub secret_keys: Vec<SecretKey>,
    pub events: Vec<RelatedEvent>,
    /// The pod section: filled for pods, empty (default) for other kinds.
    /// Not an `Option`, which would split the TypeScript type in two.
    pub pod: PodExtras,
}

#[cfg(test)]
mod test_support {
    use super::*;

    pub(super) fn rref(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceRef {
        ResourceRef {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced,
        }
    }

    pub(super) fn kind(group: &str, kind: &str, plural: &str, short: &[&str]) -> ResourceKind {
        let resource = rref(group, kind, plural, true);
        ResourceKind {
            id: resource.id(),
            label: String::new(),
            category: Category::Other,
            crd: false,
            verbs: vec![],
            short_names: short.iter().map(|s| s.to_string()).collect(),
            columns: vec![],
            actions: vec![],
            resource,
        }
    }
}
