//! A pod's STATUS the way `kubectl get pods` prints it: the same steps as
//! `printPod` in kubernetes' `pkg/printers/internalversion/printers.go`.
//!
//! 1. `status.reason`, else the phase; `SchedulingGated` while gated.
//! 2. The first init container that has not finished: `Init:<reason>`,
//!    `Init:Signal:N`, `Init:ExitCode:N` or `Init:i/n`. Running sidecars
//!    (init containers with `restartPolicy: Always`) don't count.
//! 3. Once initialized, the first container that waits or terminated:
//!    its reason, or `Signal:N` / `ExitCode:N`. `Completed` with a container
//!    still running is `Running` (pod Ready) or `NotReady`.
//! 4. Deleted: `Unknown` on an unreachable node, else `Terminating` unless
//!    the pod already finished.

use super::jsonpath::array_at;
use serde_json::Value;

fn str_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn int_at(v: &Value, pointer: &str) -> i64 {
    v.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

fn condition_true(v: &Value, type_: &str) -> bool {
    array_at(v, "/status/conditions")
        .any(|c| str_at(c, "/type") == type_ && str_at(c, "/status") == "True")
}

/// `Signal:N` or `ExitCode:N` for a terminated state without a reason.
fn exit_text(terminated: &Value) -> String {
    match int_at(terminated, "/signal") {
        0 => format!("ExitCode:{}", int_at(terminated, "/exitCode")),
        signal => format!("Signal:{signal}"),
    }
}

/// The STATUS column of `kubectl get pods`.
pub fn printed_pod_status(v: &Value) -> String {
    let phase = str_at(v, "/status/phase");
    let mut reason = match str_at(v, "/status/reason") {
        "" => phase.to_string(),
        r => r.to_string(),
    };
    let gated = array_at(v, "/status/conditions")
        .any(|c| str_at(c, "/type") == "PodScheduled" && str_at(c, "/reason") == "SchedulingGated");
    if gated {
        reason = "SchedulingGated".into();
    }

    let init_specs: Vec<&Value> = array_at(v, "/spec/initContainers").collect();
    let sidecar = |name: &str| {
        init_specs
            .iter()
            .any(|c| str_at(c, "/name") == name && str_at(c, "/restartPolicy") == "Always")
    };
    let mut initializing = false;
    for (i, c) in array_at(v, "/status/initContainerStatuses").enumerate() {
        let terminated = c.pointer("/state/terminated");
        if terminated.is_some_and(|t| int_at(t, "/exitCode") == 0) {
            continue;
        }
        if sidecar(str_at(c, "/name")) && c.get("started") == Some(&Value::Bool(true)) {
            continue;
        }
        let waiting = str_at(c, "/state/waiting/reason");
        reason = match terminated {
            Some(t) => match str_at(t, "/reason") {
                "" => format!("Init:{}", exit_text(t)),
                r => format!("Init:{r}"),
            },
            None if !waiting.is_empty() && waiting != "PodInitializing" => {
                format!("Init:{waiting}")
            }
            None => format!("Init:{i}/{}", init_specs.len()),
        };
        initializing = true;
        break;
    }

    if !initializing || condition_true(v, "Initialized") {
        let mut has_running = false;
        let containers: Vec<&Value> = array_at(v, "/status/containerStatuses").collect();
        // Last to first, so the first container's reason wins.
        for c in containers.into_iter().rev() {
            let waiting = str_at(c, "/state/waiting/reason");
            let terminated = c.pointer("/state/terminated");
            if !waiting.is_empty() {
                reason = waiting.to_string();
            } else if let Some(t) = terminated {
                reason = match str_at(t, "/reason") {
                    "" => exit_text(t),
                    r => r.to_string(),
                };
            } else if c.get("ready") == Some(&Value::Bool(true))
                && c.pointer("/state/running").is_some()
            {
                has_running = true;
            }
        }
        if reason == "Completed" && has_running {
            reason = if condition_true(v, "Ready") {
                "Running".into()
            } else {
                "NotReady".into()
            };
        }
    }

    if v.pointer("/metadata/deletionTimestamp").is_some() {
        if str_at(v, "/status/reason") == "NodeLost" {
            reason = "Unknown".into();
        } else if phase != "Succeeded" && phase != "Failed" {
            reason = "Terminating".into();
        }
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pods captured from a kind v1.37 cluster with `kubectl get pod -o json`
    /// (managedFields and most of the spec dropped), see
    /// `testdata/pod_status/`. The expected text is what `kubectl get pods`
    /// printed for the same object.
    fn fixture(name: &str) -> Value {
        let path = format!(
            "{}/src/resources/testdata/pod_status/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn matches_kubectl_for_real_pods() {
        let cases = [
            ("running", "Running"),
            ("crashed-backoff-error", "Error"),
            ("crashed-crashloop", "CrashLoopBackOff"),
            ("completed", "Completed"),
            ("not-ready", "NotReady"),
            ("killed", "Error"),
            ("bad-image", "ImagePullBackOff"),
            ("init-error", "Init:Error"),
            ("init-crashloop", "Init:CrashLoopBackOff"),
            ("init-waiting", "Init:1/2"),
            ("sidecar", "Running"),
            ("terminating", "Terminating"),
        ];
        for (name, want) in cases {
            assert_eq!(printed_pod_status(&fixture(name)), want, "{name}");
        }
    }

    /// Runtimes that leave `terminated.reason` empty: kubectl prints the
    /// signal, else the exit code.
    #[test]
    fn terminated_without_reason_shows_signal_or_exit_code() {
        let mut pod = fixture("crashed-backoff-error");
        let t = pod
            .pointer_mut("/status/containerStatuses/0/state/terminated")
            .unwrap();
        t.as_object_mut().unwrap().remove("reason");
        assert_eq!(printed_pod_status(&pod), "ExitCode:1");
        t_set(
            &mut pod,
            "/status/containerStatuses/0/state/terminated",
            "signal",
            9,
        );
        assert_eq!(printed_pod_status(&pod), "Signal:9");

        let mut init = fixture("init-error");
        let t = init
            .pointer_mut("/status/initContainerStatuses/0/state/terminated")
            .unwrap();
        t.as_object_mut().unwrap().remove("reason");
        assert_eq!(printed_pod_status(&init), "Init:ExitCode:3");
        t_set(
            &mut init,
            "/status/initContainerStatuses/0/state/terminated",
            "signal",
            15,
        );
        assert_eq!(printed_pod_status(&init), "Init:Signal:15");
    }

    /// The overview prints the typed pod with the same function.
    #[test]
    fn typed_pods_print_the_same() {
        for name in [
            "crashed-backoff-error",
            "init-waiting",
            "not-ready",
            "terminating",
        ] {
            let v = fixture(name);
            let pod: k8s_openapi::api::core::v1::Pod = serde_json::from_value(v.clone()).unwrap();
            assert_eq!(
                crate::overview::pod_status(&pod),
                printed_pod_status(&v),
                "{name}"
            );
        }
    }

    fn t_set(v: &mut Value, pointer: &str, key: &str, n: i64) {
        v.pointer_mut(pointer).unwrap()[key] = n.into();
    }

    #[test]
    fn deleted_pods() {
        let mut done = fixture("completed");
        done["metadata"]["deletionTimestamp"] = "2026-11-16T10:00:00Z".into();
        // A finished pod keeps its status while it is deleted.
        assert_eq!(printed_pod_status(&done), "Completed");
        let mut lost = fixture("running");
        lost["metadata"]["deletionTimestamp"] = "2026-11-16T10:00:00Z".into();
        lost["status"]["reason"] = "NodeLost".into();
        assert_eq!(printed_pod_status(&lost), "Unknown");
    }

    #[test]
    fn status_reason_and_scheduling_gates() {
        let evicted = serde_json::json!({"status": {"phase": "Failed", "reason": "Evicted"}});
        assert_eq!(printed_pod_status(&evicted), "Evicted");
        let gated = serde_json::json!({"status": {"phase": "Pending", "conditions": [
            {"type": "PodScheduled", "status": "False", "reason": "SchedulingGated"}
        ]}});
        assert_eq!(printed_pod_status(&gated), "SchedulingGated");
        assert_eq!(printed_pod_status(&serde_json::json!({})), "");
    }
}
