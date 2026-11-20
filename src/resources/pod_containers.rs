//! The Pods table's Containers cell (#379): one entry per container, init
//! containers first, with its state, for the UI's state squares.
//!
//! The cell is plain text, so it rides in the trimmed watch row (#397) like
//! any other cell and reads well in a CSV export or the filter:
//!
//! ```text
//! init:setup=done app=ready sidecar=waiting:CrashLoopBackOff
//! ```
//!
//! One entry per container, space-separated: `[init:]name=state[:reason[:exit]]`.
//! Container names are DNS labels, so they hold no space, `=` or `:`; the
//! reason is reduced to `[A-Za-z0-9._-]`. States:
//!
//! - `ready`: running and ready;
//! - `running`: running, not ready;
//! - `waiting`, with the reason (`ContainerCreating`, `CrashLoopBackOff`);
//! - `done`: terminated with exit code 0 (and not OOM-killed), with the
//!   reason unless it is the usual `Completed`;
//! - `failed`: terminated otherwise, with the reason and the exit code;
//! - `unknown`: in the spec, no status yet (not scheduled, or just created).

use super::jsonpath::array_at;
use serde_json::Value;

/// The longest reason kept; kubelet's reasons are short CamelCase words.
const MAX_REASON: usize = 48;
/// A container name is a DNS label: at most 63 characters.
const MAX_NAME: usize = 63;

pub(super) fn pod_containers(v: &Value) -> String {
    let mut out = String::new();
    for (init, spec, status) in [
        (true, "/spec/initContainers", "/status/initContainerStatuses"),
        (false, "/spec/containers", "/status/containerStatuses"),
    ] {
        let statuses: Vec<&Value> = array_at(v, status).collect();
        for c in array_at(v, spec) {
            let Some(name) = c.get("name").and_then(Value::as_str) else {
                continue;
            };
            let st = statuses
                .iter()
                .find(|s| s.get("name").and_then(Value::as_str) == Some(name));
            if !out.is_empty() {
                out.push(' ');
            }
            if init {
                out.push_str("init:");
            }
            out.push_str(&clean(name, MAX_NAME));
            out.push('=');
            out.push_str(&state_of(st.copied()));
        }
    }
    // Kept in every row of the table: no spare capacity.
    out.shrink_to_fit();
    out
}

fn state_of(st: Option<&Value>) -> String {
    let Some(st) = st else {
        return "unknown".into();
    };
    let state = st.get("state");
    let reason = |key: &str| {
        state
            .and_then(|s| s.pointer(&format!("/{key}/reason")))
            .and_then(Value::as_str)
            .map(|r| clean(r, MAX_REASON))
            .unwrap_or_default()
    };
    if state.and_then(|s| s.get("running")).is_some() {
        return if st.get("ready") == Some(&Value::Bool(true)) {
            "ready".into()
        } else {
            "running".into()
        };
    }
    if state.and_then(|s| s.get("waiting")).is_some() {
        let r = reason("waiting");
        return if r.is_empty() {
            "waiting".into()
        } else {
            format!("waiting:{r}")
        };
    }
    if let Some(t) = state.and_then(|s| s.get("terminated")) {
        let r = reason("terminated");
        let code = t.get("exitCode").and_then(Value::as_i64).unwrap_or(0);
        return if code == 0 && r != "OOMKilled" {
            // `Completed` is what exit 0 always says.
            if r.is_empty() || r == "Completed" {
                "done".into()
            } else {
                format!("done:{r}")
            }
        } else {
            format!("failed:{r}:{code}")
        };
    }
    "unknown".into()
}

/// Only `[A-Za-z0-9._-]`, at most `max` of them, so the cell stays
/// parseable whatever a runtime puts in a reason.
fn clean(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn init_containers_first_then_containers_with_their_states() {
        let pod = json!({
            "spec": {
                "initContainers": [{"name": "setup"}, {"name": "proxy", "restartPolicy": "Always"}],
                "containers": [{"name": "app"}, {"name": "sidecar"}, {"name": "slow"}, {"name": "new"}]
            },
            "status": {
                "initContainerStatuses": [
                    {"name": "setup", "ready": false,
                     "state": {"terminated": {"exitCode": 0, "reason": "Completed"}}},
                    {"name": "proxy", "ready": true, "state": {"running": {}}}
                ],
                "containerStatuses": [
                    // Statuses come in any order; they are matched by name.
                    {"name": "sidecar", "ready": false,
                     "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off"}}},
                    {"name": "app", "ready": true, "state": {"running": {}}},
                    {"name": "slow", "ready": false, "state": {"running": {}}}
                ]
            }
        });
        assert_eq!(
            pod_containers(&pod),
            "init:setup=done init:proxy=ready app=ready \
             sidecar=waiting:CrashLoopBackOff slow=running new=unknown"
        );
    }

    #[test]
    fn terminated_with_an_error_or_oom_is_failed_with_its_exit_code() {
        let term = |t: Value| {
            pod_containers(&json!({
                "spec": {"containers": [{"name": "a"}]},
                "status": {"containerStatuses": [{"name": "a", "state": {"terminated": t}}]}
            }))
        };
        assert_eq!(term(json!({"exitCode": 1, "reason": "Error"})), "a=failed:Error:1");
        assert_eq!(
            term(json!({"exitCode": 0, "reason": "OOMKilled"})),
            "a=failed:OOMKilled:0"
        );
        assert_eq!(term(json!({"exitCode": 2})), "a=failed::2");
        assert_eq!(term(json!({"exitCode": 0})), "a=done");
        assert_eq!(term(json!({"exitCode": 0, "reason": "Completed"})), "a=done");
        assert_eq!(
            term(json!({"exitCode": 0, "reason": "Evicted"})),
            "a=done:Evicted"
        );
    }

    #[test]
    fn a_pod_without_status_or_containers() {
        assert_eq!(pod_containers(&json!({})), "");
        assert_eq!(
            pod_containers(&json!({"spec": {"containers": [{"name": "a"}]}})),
            "a=unknown"
        );
        // A waiting state without a reason.
        assert_eq!(
            pod_containers(&json!({
                "spec": {"containers": [{"name": "a"}]},
                "status": {"containerStatuses": [{"name": "a", "state": {"waiting": {}}}]}
            })),
            "a=waiting"
        );
    }

    #[test]
    fn reasons_are_cleaned_so_the_cell_stays_parseable() {
        let pod = json!({
            "spec": {"containers": [{"name": "a"}]},
            "status": {"containerStatuses": [{"name": "a",
                "state": {"waiting": {"reason": "Bad reason: with=spaces,\u{202e}and more"}}}]}
        });
        assert_eq!(pod_containers(&pod), "a=waiting:Badreasonwithspacesandmore");
    }
}
