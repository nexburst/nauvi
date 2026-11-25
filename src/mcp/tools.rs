//! The tool catalogue (names, descriptions, input schemas) and the
//! dispatcher. Nothing here knows the protocol: [`super::server`] turns a
//! `tools/list` into [`catalogue`] and a `tools/call` into [`check`] and
//! [`call`].

use super::limits::{self, cap_text};
use super::{read_tools as read, write_tools as write};
use crate::problems;
use anyhow::{anyhow, bail, Result};
use kube::Client;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};

/// One tool as `tools/list` shows it.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub title: &'static str,
    pub description: String,
    pub input_schema: Value,
    /// Changes the cluster: offered only with `--allow-writes`.
    pub writes: bool,
    /// May remove or replace something (a hint for clients).
    pub destructive: bool,
}

const KIND: &str = "Resource type: plural, kind or short name (pods, deploy, svc, \
     widgets.example.com), or <kind>/<name> for one object";
const NAMESPACE_ONE: &str = "Namespace of the object (default: the context's namespace)";

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn object_properties() -> Value {
    json!({
        "kind": { "type": "string", "description": KIND },
        "name": { "type": "string", "description": "Object name (leave out if kind is <kind>/<name>)" },
        "namespace": { "type": "string", "description": NAMESPACE_ONE },
    })
}

fn read_tools() -> Vec<ToolSpec> {
    let caps = format!(
        "Output is capped at {} lines and {} KiB.",
        limits::MAX_LINES,
        limits::MAX_BYTES / 1024
    );
    vec![
        ToolSpec {
            name: "list",
            title: "List resources",
            description: format!(
                "List objects of one resource type (any kind, CRDs included) as a kubectl-get table. \
                 All namespaces unless namespace is given. Pods get a LAST column (the newest \
                 container termination and its age, e.g. OOMKilled 27d). columns keeps only the \
                 named columns; compact drops NODE, and NAMESPACE when namespace is given. \
                 Returns at most `limit` objects (default {}, max {}). {caps}",
                limits::DEFAULT_LIST,
                limits::MAX_LIST
            ),
            input_schema: schema(
                json!({
                    "kind": { "type": "string", "description": "Resource type: plural, kind or short name (pods, deploy, svc, widgets.example.com)" },
                    "namespace": { "type": "string", "description": "Only this namespace (default: all namespaces)" },
                    "label_selector": { "type": "string", "description": "Label selector, e.g. app=web,tier!=db" },
                    "field_selector": { "type": "string", "description": "Field selector, e.g. status.phase=Running" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": limits::MAX_LIST },
                    "columns": { "type": "array", "items": { "type": "string" }, "description": "Only these columns, by header name, e.g. [\"name\",\"status\",\"restarts\",\"last\",\"age\"]" },
                    "compact": { "type": "boolean", "description": "Leave out NODE, and NAMESPACE when namespace is given" },
                }),
                &["kind"],
            ),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "get",
            title: "Get one object",
            description: format!(
                "One object as YAML, without managedFields. Secret values and the \
                 last-applied-configuration annotation are always redacted (Secret keys are kept). {caps}"
            ),
            input_schema: schema(object_properties(), &["kind"]),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "describe",
            title: "Describe one object",
            description: format!(
                "Describe one object like kubectl describe: metadata, owners, related objects, \
                 conditions, containers (environment variable names, not values), Secret keys \
                 and sizes, and recent events. {caps}"
            ),
            input_schema: schema(object_properties(), &["kind"]),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "logs",
            title: "Read logs",
            description: format!(
                "The last lines of a pod's logs, or of each pod of a workload (deploy/<name>, \
                 sts/<name>, ds/<name>, job/<name>, rs/<name>; at most {} pods, lines prefixed \
                 with [pod]). tail defaults to {} and is at most {}. The newest lines are kept \
                 within the cap. {caps}",
                limits::MAX_LOG_PODS,
                limits::DEFAULT_TAIL,
                limits::MAX_TAIL
            ),
            input_schema: schema(
                json!({
                    "target": { "type": "string", "description": "Pod name, or <workload kind>/<name>" },
                    "namespace": { "type": "string", "description": NAMESPACE_ONE },
                    "container": { "type": "string", "description": "Container name (default: the pod's default container)" },
                    "previous": { "type": "boolean", "description": "Logs of the previous (crashed) container instance" },
                    "tail": { "type": "integer", "minimum": 1, "maximum": limits::MAX_TAIL },
                    "since_seconds": { "type": "integer", "minimum": 1, "description": "Only lines newer than this many seconds" },
                }),
                &["target"],
            ),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "events",
            title: "List events",
            description: format!(
                "Kubernetes events, newest first: of a namespace, of all namespaces, or of one \
                 object (kind and name). At most `limit` (default {}, max {}). {caps}",
                limits::DEFAULT_EVENTS,
                limits::MAX_EVENTS
            ),
            input_schema: schema(
                json!({
                    "namespace": { "type": "string", "description": "Only this namespace (default: all, or the context's namespace for one object)" },
                    "kind": { "type": "string", "description": "With name: only events of this object" },
                    "name": { "type": "string" },
                    "warnings_only": { "type": "boolean" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": limits::MAX_EVENTS },
                }),
                &[],
            ),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "problems",
            title: "What is wrong, and why",
            description: format!(
                "Only the unhealthy objects, newest problem first, one line each with the why \
                 (last termination reason, exit code and age, the memory limit for OOMKilled and exit 137, \
                 eviction and failure messages, conditions): crash-looping, failed, not ready or \
                 overdue pending pods, pods restarted in the last 24 h, workloads short of ready \
                 replicas, failed Jobs, not-ready Nodes, lost PVCs. The same rules as the app's \
                 badges. Older restarts are listed apart as history. kinds narrows the check \
                 (pods, deployments, statefulsets, daemonsets, replicasets, jobs, nodes, \
                 persistentvolumeclaims; Nodes only without namespace unless asked for). \
                 At most `limit` rows (default {}, max {}); at most {} objects of each kind \
                 are read. Start a health check here. {caps}",
                problems::DEFAULT_PROBLEMS,
                problems::MAX_PROBLEMS,
                problems::MAX_READ_PER_KIND
            ),
            input_schema: schema(
                json!({
                    "namespace": { "type": "string", "description": "Only this namespace (default: all namespaces)" },
                    "kinds": { "type": "array", "items": { "type": "string" }, "description": "Only these kinds (default: all of them)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": problems::MAX_PROBLEMS },
                }),
                &[],
            ),
            writes: false,
            destructive: false,
        },
        ToolSpec {
            name: "top",
            title: "CPU and memory usage",
            description: format!(
                "CPU and memory usage of pods or nodes from metrics-server (like kubectl top), \
                 heaviest first, at most `limit` rows (default {}, max {}).",
                limits::DEFAULT_LIST,
                limits::MAX_LIST
            ),
            input_schema: schema(
                json!({
                    "resource": { "type": "string", "enum": ["pods", "nodes"] },
                    "namespace": { "type": "string", "description": "Pods: only this namespace (default: all)" },
                    "sort_by": { "type": "string", "enum": ["cpu", "memory"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": limits::MAX_LIST },
                }),
                &[],
            ),
            writes: false,
            destructive: false,
        },
    ]
}

fn write_tools() -> Vec<ToolSpec> {
    let rbac = "Runs as the kubeconfig's user: RBAC applies.";
    vec![
        ToolSpec {
            name: "scale",
            title: "Scale a workload",
            description: format!(
                "Set the replica count of a Deployment, StatefulSet or ReplicaSet. {rbac}"
            ),
            input_schema: schema(
                {
                    let mut p = object_properties();
                    p["replicas"] = json!({ "type": "integer", "minimum": 0 });
                    p
                },
                &["kind", "replicas"],
            ),
            writes: true,
            destructive: true,
        },
        ToolSpec {
            name: "restart",
            title: "Rollout restart",
            description: format!(
                "Rollout restart of a Deployment, StatefulSet or DaemonSet (kubectl rollout restart). {rbac}"
            ),
            input_schema: schema(object_properties(), &["kind"]),
            writes: true,
            destructive: false,
        },
        ToolSpec {
            name: "delete",
            title: "Delete one object",
            description: format!("Delete one named object of any kind. {rbac}"),
            input_schema: schema(object_properties(), &["kind"]),
            writes: true,
            destructive: true,
        },
        ToolSpec {
            name: "apply",
            title: "Apply a manifest",
            description: format!(
                "Server-side apply of a YAML manifest (one or more documents, at most {} KiB). \
                 Every object is validated with a dry run first; dry_run only validates. {rbac}",
                limits::MAX_MANIFEST_BYTES / 1024
            ),
            input_schema: schema(
                json!({
                    "manifest": { "type": "string", "description": "YAML, documents separated by ---" },
                    "namespace": { "type": "string", "description": "For objects without a namespace (default: the context's namespace)" },
                    "dry_run": { "type": "boolean" },
                }),
                &["manifest"],
            ),
            writes: true,
            destructive: true,
        },
    ]
}

/// The tools the server offers: the read-only ones, and the write ones
/// only when `allow_writes`.
pub fn catalogue(allow_writes: bool) -> Vec<ToolSpec> {
    let mut tools = read_tools();
    if allow_writes {
        tools.extend(write_tools());
    }
    tools
}

/// Whether `name` may be called. Checked before the server connects to the
/// cluster.
/// Whether `name` is a tool that changes the cluster.
pub fn writes(name: &str) -> bool {
    write_tools().iter().any(|t| t.name == name)
}

pub fn check(name: &str, allow_writes: bool) -> Result<()> {
    if read_tools().iter().any(|t| t.name == name) {
        return Ok(());
    }
    if write_tools().iter().any(|t| t.name == name) {
        if allow_writes {
            return Ok(());
        }
        bail!(
            "the {name} tool changes the cluster and is off: the server is read-only unless \
             started with `nauvi mcp --allow-writes`"
        );
    }
    bail!("unknown tool: {name}")
}

fn args<T: DeserializeOwned>(tool: &str, arguments: Option<Map<String, Value>>) -> Result<T> {
    serde_json::from_value(Value::Object(arguments.unwrap_or_default()))
        .map_err(|e| anyhow!("invalid arguments for {tool}: {e}"))
}

/// Run a tool (after [`check`]) and return its text, capped.
pub async fn call(
    client: &Client,
    name: &str,
    arguments: Option<Map<String, Value>>,
    allow_writes: bool,
) -> Result<String> {
    check(name, allow_writes)?;
    let a = arguments;
    let text = match name {
        "list" => read::list(client, &args(name, a)?).await,
        "get" => read::get(client, &args(name, a)?).await,
        "describe" => read::describe(client, &args(name, a)?).await,
        "logs" => read::logs(client, &args(name, a)?).await,
        "events" => read::events(client, &args(name, a)?).await,
        "top" => read::top(client, &args(name, a)?).await,
        "problems" => problems::problems(client, &args(name, a)?).await,
        "scale" => write::scale(client, &args(name, a)?).await,
        "restart" => write::restart(client, &args(name, a)?).await,
        "delete" => write::delete(client, &args(name, a)?).await,
        "apply" => write::apply(client, &args(name, a)?).await,
        other => bail!("unknown tool: {other}"),
    }?;
    Ok(cap_text(&text, limits::MAX_LINES, limits::MAX_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(allow_writes: bool) -> Vec<&'static str> {
        catalogue(allow_writes).iter().map(|t| t.name).collect()
    }

    #[test]
    fn read_only_by_default() {
        assert_eq!(
            names(false),
            ["list", "get", "describe", "logs", "events", "problems", "top"]
        );
        assert!(catalogue(false).iter().all(|t| !t.writes));
        let all = names(true);
        assert_eq!(&all[7..], ["scale", "restart", "delete", "apply"]);
        assert!(catalogue(true).iter().filter(|t| t.writes).count() == 4);
    }

    #[test]
    fn write_tools_are_refused_without_the_flag() {
        for tool in ["scale", "restart", "delete", "apply"] {
            let err = check(tool, false).unwrap_err().to_string();
            assert!(err.contains("--allow-writes"), "{err}");
            assert!(check(tool, true).is_ok());
        }
        assert!(check("get", false).is_ok());
        assert!(check("exec", true)
            .unwrap_err()
            .to_string()
            .contains("unknown tool"));
    }

    #[test]
    fn schemas_are_closed_objects_naming_their_required_fields() {
        for t in catalogue(true) {
            let s = &t.input_schema;
            assert_eq!(s["type"], "object", "{}", t.name);
            assert_eq!(s["additionalProperties"], false, "{}", t.name);
            for r in s["required"].as_array().unwrap() {
                let r = r.as_str().unwrap();
                assert!(s["properties"].get(r).is_some(), "{}: {r}", t.name);
            }
            assert!(!t.description.is_empty());
        }
    }

    #[test]
    fn no_tool_offers_to_reveal_secrets() {
        for t in catalogue(true) {
            let props = t.input_schema["properties"].as_object().unwrap();
            assert!(!props.contains_key("reveal"), "{}", t.name);
            assert!(!props.contains_key("output"), "{}", t.name);
        }
    }

    #[test]
    fn bad_arguments_are_named() {
        let mut m = Map::new();
        m.insert("kind".into(), json!(5));
        let err = args::<read::ObjectArgs>("get", Some(m)).unwrap_err();
        assert!(
            err.to_string().starts_with("invalid arguments for get"),
            "{err}"
        );
        let err = args::<read::ObjectArgs>("get", None).unwrap_err();
        assert!(err.to_string().contains("kind"), "{err}");
    }
}
