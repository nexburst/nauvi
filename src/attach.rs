//! Attach to a container's main process (`kubectl attach -it`): its stdin
//! and output, instead of a new shell. For interactive containers and for
//! images without a shell.
//!
//! Detaching (closing the session) leaves the process running, unless the
//! container sets `stdinOnce`: then its stdin closes on the first detach,
//! which usually ends it.

use crate::actions::{api_error, describe_status};
use crate::debug::attach_container;
use anyhow::{bail, Context, Result};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachedProcess};
use kube::Client;

/// `kubectl`'s annotation naming the container commands default to.
pub const DEFAULT_CONTAINER: &str = "kubectl.kubernetes.io/default-container";

/// The container an attach connects to, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachTarget {
    pub container: String,
    /// The container has a TTY: the session gets one too.
    pub tty: bool,
    /// Detaching closes the container's stdin (`stdinOnce`).
    pub stdin_once: bool,
}

/// Which container of `pod` to attach to, and whether it can be: it must
/// keep its stdin open (`stdin: true`) and be running. `requested` may be a
/// regular or an ephemeral container; without it, the pod's default
/// container (annotation) or its first one. Pure.
pub fn attach_target(pod: &Pod, requested: Option<&str>) -> Result<AttachTarget> {
    let spec = pod.spec.as_ref().context("the pod has no spec")?;
    // (name, stdin, stdin_once, tty) of the regular, then the ephemeral containers.
    let containers: Vec<(&str, bool, bool, bool)> = spec
        .containers
        .iter()
        .map(|c| {
            (
                c.name.as_str(),
                c.stdin.unwrap_or(false),
                c.stdin_once.unwrap_or(false),
                c.tty.unwrap_or(false),
            )
        })
        .chain(spec.ephemeral_containers.iter().flatten().map(|c| {
            (
                c.name.as_str(),
                c.stdin.unwrap_or(false),
                c.stdin_once.unwrap_or(false),
                c.tty.unwrap_or(false),
            )
        }))
        .collect();
    let names = || {
        containers
            .iter()
            .map(|c| c.0)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let default = pod
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(DEFAULT_CONTAINER))
        .map(String::as_str);
    let wanted = requested.filter(|c| !c.is_empty()).or(default);
    let &(name, stdin, stdin_once, tty) = match wanted {
        Some(w) => containers
            .iter()
            .find(|c| c.0 == w)
            .with_context(|| format!("the pod has no container named {w} (it has: {})", names()))?,
        None => containers.first().context("the pod has no containers")?,
    };
    if !stdin {
        bail!(
            "container {name} was not started with stdin open (stdin: true in its spec), so there is no input to attach to. Use Shell to run a new shell in it, or Logs to see its output."
        );
    }
    let status = pod.status.as_ref();
    let state = status
        .into_iter()
        .flat_map(|s| {
            s.container_statuses
                .iter()
                .flatten()
                .chain(s.ephemeral_container_statuses.iter().flatten())
        })
        .find(|s| s.name == name)
        .and_then(|s| s.state.as_ref());
    if !state.is_some_and(|s| s.running.is_some()) {
        let why = state
            .and_then(|s| {
                s.waiting
                    .as_ref()
                    .and_then(|w| w.reason.clone())
                    .or_else(|| {
                        s.terminated
                            .as_ref()
                            .map(|t| t.reason.clone().unwrap_or_else(|| "Terminated".into()))
                    })
            })
            .unwrap_or_else(|| "not started".into());
        bail!("container {name} is not running ({why}): there is no process to attach to");
    }
    Ok(AttachTarget {
        container: name.to_string(),
        tty,
        stdin_once,
    })
}

/// The note shown when the session starts.
pub fn attach_note(pod: &str, t: &AttachTarget, detach: &str) -> String {
    let mut out = format!("Attached to {pod}/{}. {detach}", t.container);
    if t.stdin_once {
        out.push_str(
            " This container closes its stdin when you detach (stdinOnce), which usually ends its process.",
        );
    } else {
        out.push_str(" The process keeps running.");
    }
    if t.tty {
        out.push_str(" If you don't see a prompt, press Enter.");
    } else {
        out.push_str(" The container has no TTY: what you type is not echoed.");
    }
    out
}

/// Plain words for a failed attach.
pub fn describe_attach_error(err: &anyhow::Error) -> String {
    match api_error(err) {
        Some((403, msg)) => {
            format!("Not allowed: attaching needs permission to create pods/attach. {msg}")
        }
        Some((code, msg)) => describe_status(code, &msg),
        None => format!("{err:#}"),
    }
}

/// Look the pod up, check the container ([`attach_target`]) and attach to it.
pub async fn attach_pod(
    client: &Client,
    namespace: &str,
    name: &str,
    container: Option<&str>,
) -> Result<(AttachTarget, AttachedProcess)> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(name).await?;
    let target = attach_target(&pod, container)?;
    let process = attach_container(client, namespace, name, &target.container, target.tty).await?;
    Ok((target, process))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(containers: serde_json::Value, statuses: serde_json::Value) -> Pod {
        serde_json::from_value(json!({
            "metadata": { "name": "p", "namespace": "n" },
            "spec": { "containers": containers },
            "status": { "phase": "Running", "containerStatuses": statuses }
        }))
        .unwrap()
    }

    fn running(name: &str) -> serde_json::Value {
        json!({ "name": name, "image": "x", "imageID": "", "ready": true, "restartCount": 0,
                "state": { "running": {} } })
    }

    #[test]
    fn picks_an_interactive_running_container() {
        let p = pod(
            json!([
                { "name": "sidecar", "image": "x" },
                { "name": "app", "image": "x", "stdin": true, "tty": true }
            ]),
            json!([running("sidecar"), running("app")]),
        );
        let t = attach_target(&p, Some("app")).unwrap();
        assert_eq!(
            t,
            AttachTarget {
                container: "app".into(),
                tty: true,
                stdin_once: false
            }
        );
        // The first container by default; it has no stdin.
        let err = attach_target(&p, None).unwrap_err().to_string();
        assert!(
            err.contains("container sidecar was not started with stdin open"),
            "{err}"
        );
        assert!(err.contains("Use Shell"), "{err}");
        let err = attach_target(&p, Some("nope")).unwrap_err().to_string();
        assert_eq!(
            err,
            "the pod has no container named nope (it has: sidecar, app)"
        );
    }

    #[test]
    fn honours_the_default_container_annotation() {
        let mut p = pod(
            json!([
                { "name": "sidecar", "image": "x" },
                { "name": "app", "image": "x", "stdin": true, "stdinOnce": true }
            ]),
            json!([running("sidecar"), running("app")]),
        );
        p.metadata.annotations = Some([(DEFAULT_CONTAINER.to_string(), "app".to_string())].into());
        let t = attach_target(&p, None).unwrap();
        assert_eq!(t.container, "app");
        assert!(!t.tty);
        assert!(t.stdin_once);
        let note = attach_note("p", &t, "Close the tab to detach.");
        assert!(
            note.starts_with("Attached to p/app. Close the tab to detach."),
            "{note}"
        );
        assert!(note.contains("stdinOnce"), "{note}");
        assert!(note.contains("not echoed"), "{note}");
    }

    #[test]
    fn refuses_a_container_that_is_not_running() {
        let p = pod(
            json!([{ "name": "app", "image": "x", "stdin": true, "tty": true }]),
            json!([{ "name": "app", "image": "x", "imageID": "", "ready": false, "restartCount": 3,
                     "state": { "waiting": { "reason": "CrashLoopBackOff" } } }]),
        );
        let err = attach_target(&p, None).unwrap_err().to_string();
        assert_eq!(
            err,
            "container app is not running (CrashLoopBackOff): there is no process to attach to"
        );
        let t = AttachTarget {
            container: "app".into(),
            tty: true,
            stdin_once: false,
        };
        let note = attach_note("p", &t, "");
        assert!(note.contains("keeps running"), "{note}");
        assert!(note.contains("press Enter"), "{note}");
    }

    #[test]
    fn errors_name_the_missing_permission() {
        let err = anyhow::Error::new(kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".into(),
            message: "pods \"p\" is forbidden".into(),
            reason: "Forbidden".into(),
            code: 403,
        }));
        assert!(describe_attach_error(&err)
            .starts_with("Not allowed: attaching needs permission to create pods/attach."));
    }
}
