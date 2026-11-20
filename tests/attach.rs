//! Integration tests of attach, all-container pod logs and problem rows
//! against the kind cluster. `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test attach -- --ignored`.
//!
//! The attach tests use interactive pods they create in a temporary
//! namespace; the others only read the shared demo objects.

mod common;

use std::collections::BTreeSet;
use std::future::Future;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use futures::StreamExt;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use nauvi::attach::{attach_pod, describe_attach_error};
use nauvi::resources::{discover, list_resources};
use nauvi::watch::{watch_resource, Update};
use nauvi::{client_for_context, stream_pod_containers_logs, LogOptions, WorkloadEvent};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const TIMEOUT: Duration = Duration::from_secs(120);

fn context() -> String {
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string())
}

async fn connect() -> Result<Client> {
    let ctx = context();
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// Run `body` in a fresh namespace, deleting it afterwards even on error or
/// timeout.
async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let suffix = common::unique_suffix();
    let ns = format!("{prefix}-{suffix:x}-{seq}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(Duration::from_secs(300), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("test timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

/// A busybox `sh` as the main process: interactive when `stdin`, with a TTY
/// when `tty`.
async fn shell_pod(client: &Client, ns: &str, name: &str, stdin: bool, tty: bool) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let command = if stdin {
        serde_json::json!(["sh"])
    } else {
        serde_json::json!(["sleep", "3600"])
    };
    let pod: Pod = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": name },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "app", "image": "busybox:1.36", "command": command,
                "stdin": stdin, "tty": tty
            }]
        }
    }))?;
    pods.create(&PostParams::default(), &pod).await?;
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let p = pods.get(name).await?;
        if p.status.and_then(|s| s.phase).as_deref() == Some("Running") {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            bail!("pod {ns}/{name} did not start");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Read `r` until the output contains `needle`.
async fn read_until(r: &mut (impl AsyncRead + Unpin), needle: &str) -> Result<String> {
    let mut out = String::new();
    let mut buf = [0u8; 4096];
    let read = async {
        while !out.contains(needle) {
            let n = r.read(&mut buf).await?;
            if n == 0 {
                bail!("stream ended before {needle:?}; got {out:?}");
            }
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(60), read)
        .await
        .with_context(|| format!("timed out waiting for {needle:?}"))??;
    Ok(out)
}

/// Attach, run `echo` through the process's stdin and read the answer.
async fn echo_through(client: &Client, ns: &str, pod: &str, word: &str) -> Result<bool> {
    let (target, mut p) = attach_pod(client, ns, pod, None)
        .await
        .map_err(|e| anyhow::anyhow!(describe_attach_error(&e)))?;
    ensure!(target.container == "app");
    let mut stdin = p.stdin().context("no stdin")?;
    let mut stdout = p.stdout().context("no stdout")?;
    // `$((…))` so the answer differs from the echoed input.
    stdin
        .write_all(format!("echo {word}-$((40+2))\n").as_bytes())
        .await?;
    read_until(&mut stdout, &format!("{word}-42")).await?;
    // Detach: drop the session without closing the process's stdin.
    drop(stdin);
    drop(stdout);
    drop(p);
    Ok(target.tty)
}

async fn restarts(client: &Client, ns: &str, pod: &str) -> Result<(String, i32)> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let p = pods.get(pod).await?;
    let status = p.status.unwrap_or_default();
    let n = status
        .container_statuses
        .unwrap_or_default()
        .iter()
        .map(|c| c.restart_count)
        .sum();
    Ok((status.phase.unwrap_or_default(), n))
}

#[tokio::test]
#[ignore]
async fn attach_talks_to_the_main_process_and_detaching_keeps_it_running() -> Result<()> {
    in_temp_ns("kl-it-attach", |client, ns| async move {
        shell_pod(&client, &ns, "repl", true, true).await?;
        let tty = echo_through(&client, &ns, "repl", "first").await?;
        ensure!(tty, "the container has a TTY, so the session gets one");
        tokio::time::sleep(Duration::from_secs(3)).await;
        // Still the same process: not restarted, and it answers again.
        ensure!(restarts(&client, &ns, "repl").await? == ("Running".into(), 0));
        echo_through(&client, &ns, "repl", "second").await?;
        ensure!(restarts(&client, &ns, "repl").await? == ("Running".into(), 0));

        // Without a TTY, stdin and stdout are separate streams.
        shell_pod(&client, &ns, "pipe", true, false).await?;
        let tty = echo_through(&client, &ns, "pipe", "plain").await?;
        ensure!(!tty);
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn attach_without_stdin_or_to_a_missing_container_fails_clearly() -> Result<()> {
    in_temp_ns("kl-it-nostdin", |client, ns| async move {
        shell_pod(&client, &ns, "batch", false, false).await?;
        let Err(e) = attach_pod(&client, &ns, "batch", None).await else {
            bail!("attached to a container without stdin");
        };
        let msg = describe_attach_error(&e);
        ensure!(
            msg.contains("container app was not started with stdin open") && msg.contains("Shell"),
            "{msg}"
        );
        let Err(e) = attach_pod(&client, &ns, "batch", Some("nope")).await else {
            bail!("attached to a missing container");
        };
        let msg = describe_attach_error(&e);
        ensure!(
            msg.contains("no container named nope (it has: app)"),
            "{msg}"
        );
        let Err(e) = attach_pod(&client, &ns, "gone", None).await else {
            bail!("attached to a missing pod");
        };
        let msg = describe_attach_error(&e);
        ensure!(msg.starts_with("Already gone"), "{msg}");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn cli_attach_pipes_stdin_to_the_process() -> Result<()> {
    in_temp_ns("kl-it-cliattach", |client, ns| async move {
        shell_pod(&client, &ns, "pipe", true, false).await?;
        let mut child = Command::new(env!("CARGO_BIN_EXE_nauvi"))
            .args(["--context", &context(), "attach", "pipe", "-n", &ns])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        use std::io::{BufRead, Write};
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
                .find(|l| l.contains("cli-42"))
        });
        // The session may need a moment to connect; repeat until answered.
        for _ in 0..20 {
            if reader.is_finished() {
                break;
            }
            let _ = stdin.write_all(b"echo cli-$((40+2))\n");
            let _ = stdin.flush();
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = child.kill();
        let output = child.wait_with_output()?;
        let found = reader.join().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        ensure!(found.is_some(), "no answer; stderr: {stderr}");
        ensure!(stderr.contains("Attached to pipe/app."), "{stderr}");
        drop(client);
        Ok(())
    })
    .await
}

/// Read-only: the shared demo/multi pod (app and sidecar print lines).
#[tokio::test]
#[ignore]
async fn all_container_logs_of_demo_multi_are_tagged_by_container() -> Result<()> {
    let client = connect().await?;
    let opts = LogOptions {
        tail_lines: Some(5),
        ..LogOptions::default()
    };
    let mut started = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let stream = stream_pod_containers_logs(&client, "demo", "multi", &opts, |ev| match ev {
        WorkloadEvent::Started { pod, container } => {
            assert_eq!(pod, "multi");
            started.insert(container);
        }
        WorkloadEvent::Lines(lines) => {
            for l in lines {
                assert!(l.line.contains(&format!("{}:", l.container)), "{l:?}");
                seen.insert(l.container);
            }
        }
        _ => {}
    });
    // The stream follows forever; stop it once both have spoken.
    let _ = tokio::time::timeout(Duration::from_secs(15), stream).await;
    let want: BTreeSet<String> = ["app", "sidecar"].map(String::from).into();
    // Regular containers only: the init container is not followed.
    ensure!(started == want, "started {started:?}");
    ensure!(seen == want, "lines from {seen:?}");

    let previous = LogOptions {
        previous: true,
        ..LogOptions::default()
    };
    let err = stream_pod_containers_logs(&client, "demo", "multi", &previous, |_| {})
        .await
        .unwrap_err();
    ensure!(err.to_string().contains("one container at a time"), "{err}");
    Ok(())
}

/// Read-only: demo/crashed crash-loops, demo/web is healthy; the rows the
/// table watch sends say so, and the list rows agree.
///
/// demo/crashed is only a problem between two runs of its container (while
/// it runs it is Running and ready), and on a fresh cluster it may not have
/// crashed yet: both checks wait for it instead of assuming it.
#[tokio::test]
#[ignore]
async fn pod_rows_mark_problems_from_the_watch() -> Result<()> {
    let client = connect().await?;
    let kinds = discover(&client).await?;
    let pods = kinds
        .iter()
        .find(|k| k.id == "v1/pods")
        .context("no pods kind")?;
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let rows = loop {
        let rows = list_resources(&client, pods, Some("demo")).await?;
        let problem = rows
            .iter()
            .find(|r| r.name == "crashed")
            .map(|r| r.problem.clone())
            .context("no demo/crashed in the list")?;
        if !problem.is_empty() {
            break rows;
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "timed out after {TIMEOUT:?}: demo/crashed never had a problem in the list rows"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    };
    let crashed = &rows.iter().find(|r| r.name == "crashed").unwrap().problem;
    // Between restarts it is Not ready, otherwise backing off.
    ensure!(
        ["CrashLoopBackOff", "Not ready", "Error"].contains(&crashed.as_str()),
        "{crashed}"
    );
    for r in rows.iter().filter(|r| r.name.starts_with("web-")) {
        ensure!(r.problem.is_empty(), "{}: {}", r.name, r.problem);
    }

    // The snapshot, or a later change of the pod, marks it too.
    let mut updates = watch_resource(
        &client,
        &nauvi::liveness::Prober::new(client.clone()),
        pods,
        Some("demo"),
    );
    let mut seen = false;
    tokio::time::timeout(TIMEOUT, async {
        while let Some(u) = updates.next().await {
            let rows = match u {
                Update::Snapshot(rows) => rows,
                Update::Applied(row) => vec![row],
                _ => continue,
            };
            if let Some(r) = rows.iter().find(|r| r.name == "crashed") {
                seen = true;
                if !r.problem.is_empty() {
                    return Ok(());
                }
            }
        }
        bail!("the watch ended")
    })
    .await
    .with_context(|| {
        if seen {
            format!("timed out after {TIMEOUT:?}: the watch never marked demo/crashed as a problem")
        } else {
            format!("timed out after {TIMEOUT:?}: no demo/crashed in the watch")
        }
    })??;
    Ok(())
}
