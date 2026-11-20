//! Integration tests of port-forwarding (`PortForward`) against the kind
//! cluster. `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test portforward -- --ignored`. Each test works in its own
//! temporary namespace and binds only random local ports, so tests (and
//! other worktrees) never fight over a port.

mod common;

use std::future::Future;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod, Service};
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use kube::Client;
use nauvi::{
    client_for_context, pod_is_ready, ForwardKind, ForwardTarget, LocalPort, Multiplex,
    PortForward, RemotePort,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TIMEOUT: Duration = Duration::from_secs(120);

async fn connect() -> Result<Client> {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    let build = nauvi::for_port_forwards(client_for_context(Some(&ctx)));
    tokio::time::timeout(Duration::from_secs(20), build)
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// Run `body` in a fresh namespace, deleting it afterwards even on error.
async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    in_temp_ns_for(prefix, Duration::from_secs(300), body).await
}

/// [`in_temp_ns`] with its own time limit.
async fn in_temp_ns_for<F, Fut>(prefix: &str, limit: Duration, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    // A counter too: tests run in parallel in one process.
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let suffix = common::unique_suffix();
    let ns = format!("{prefix}-{suffix:x}-{seq}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(limit, body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("test timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

/// Poll `f` until it returns `Some`, or fail after `d`.
async fn eventually<T, Fut: Future<Output = Result<Option<T>>>>(
    what: &str,
    d: Duration,
    mut f: impl FnMut() -> Fut,
) -> Result<T> {
    let deadline = tokio::time::Instant::now() + d;
    loop {
        if let Some(v) = f().await? {
            return Ok(v);
        }
        if tokio::time::Instant::now() > deadline {
            bail!("timed out after {d:?} waiting for: {what}");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// A 2-replica nginx Deployment with a named container port, and a Service
/// whose `targetPort` is that name.
async fn create_web(client: &Client, ns: &str) -> Result<()> {
    let deploy: Deployment = serde_json::from_value(serde_json::json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 2,
            "selector": { "matchLabels": { "app": "pf-web" } },
            "template": {
                "metadata": { "labels": { "app": "pf-web" } },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{
                        "name": "nginx", "image": "nginx:1.27",
                        "ports": [{ "name": "web", "containerPort": 80 }],
                        "readinessProbe": { "httpGet": { "path": "/", "port": "web" }, "periodSeconds": 1 }
                    }]
                }
            }
        }
    }))?;
    Api::<Deployment>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &deploy)
        .await?;
    let svc: Service = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Service",
        "metadata": { "name": "web" },
        "spec": {
            "selector": { "app": "pf-web" },
            "ports": [{ "name": "http", "port": 80, "targetPort": "web" }]
        }
    }))?;
    Api::<Service>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &svc)
        .await?;
    wait_ready_pods(client, ns, 2).await?;
    Ok(())
}

async fn ready_pods(client: &Client, ns: &str) -> Result<Vec<String>> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let list = pods
        .list(&ListParams::default().labels("app=pf-web"))
        .await?;
    Ok(list
        .items
        .iter()
        .filter(|p| pod_is_ready(p))
        .filter_map(|p| p.metadata.name.clone())
        .collect())
}

async fn wait_ready_pods(client: &Client, ns: &str, n: usize) -> Result<Vec<String>> {
    eventually(&format!("{n} ready web pods"), TIMEOUT, || async {
        let ready = ready_pods(client, ns).await?;
        Ok((ready.len() >= n).then_some(ready))
    })
    .await
}

async fn http_get(port: u16) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut buf = String::new();
        s.read_to_string(&mut buf).await?;
        Ok(buf)
    })
    .await
    .context("http request timed out")?
}

fn target(kind: ForwardKind, ns: &str, name: &str) -> ForwardTarget {
    ForwardTarget {
        kind,
        namespace: ns.to_string(),
        name: name.to_string(),
    }
}

#[tokio::test]
#[ignore]
async fn service_forward_survives_deleting_the_serving_pod() -> Result<()> {
    in_temp_ns("kl-it-pf-svc", |client, ns| async move {
        create_web(&client, &ns).await?;
        // EndpointSlices lag the pods a little.
        let svc = target(ForwardKind::Service, &ns, "web");
        let fwd = eventually("service forward starts", TIMEOUT, || async {
            match PortForward::start(
                &client,
                svc.clone(),
                RemotePort::Number(80),
                LocalPort::Random,
            )
            .await
            {
                Ok(f) => Ok(Some(f)),
                Err(e) if e.to_string().contains("no ready pod") => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await?;
        ensure!(fwd.remote_port == 80);
        let body = http_get(fwd.local_port).await?;
        ensure!(body.contains("Welcome to nginx"), "{body}");
        let first = fwd.status().pod;
        ensure!(!first.is_empty(), "{:?}", fwd.status());

        // Delete the pod that served it: the next request goes elsewhere.
        Api::<Pod>::namespaced(client.clone(), &ns)
            .delete(&first, &DeleteParams::default())
            .await?;
        let body = eventually("a request after the pod is gone", TIMEOUT, || async {
            let body = http_get(fwd.local_port).await.unwrap_or_default();
            Ok(body.contains("Welcome to nginx").then_some(body))
        })
        .await?;
        ensure!(body.contains(" 200 OK"), "{body}");
        let now = fwd.status();
        ensure!(now.pod != first, "still served by the deleted pod: {now:?}");
        ensure!(now.total_connections >= 2, "{now:?}");

        // By name, through the Deployment as well.
        let deploy = target(ForwardKind::Deployment, &ns, "web");
        let fwd = PortForward::start(
            &client,
            deploy,
            RemotePort::Name("web".into()),
            LocalPort::Random,
        )
        .await?;
        ensure!(fwd.remote_port == 80, "{}", fwd.remote_port);
        let body = http_get(fwd.local_port).await?;
        ensure!(body.contains("Welcome to nginx"), "{body}");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn pod_forward_by_port_name_and_clear_errors() -> Result<()> {
    in_temp_ns("kl-it-pf-pod", |client, ns| async move {
        create_web(&client, &ns).await?;
        let pod = ready_pods(&client, &ns).await?.remove(0);

        let fwd = PortForward::start(
            &client,
            target(ForwardKind::Pod, &ns, &pod),
            RemotePort::Name("web".into()),
            LocalPort::Random,
        )
        .await?;
        let body = http_get(fwd.local_port).await?;
        ensure!(body.contains("Welcome to nginx"), "{body}");

        // Asking for the local port that is now taken.
        let err = PortForward::start(
            &client,
            target(ForwardKind::Service, &ns, "web"),
            RemotePort::Number(80),
            LocalPort::Exactly(fwd.local_port),
        )
        .await
        .err()
        .context("a busy local port was accepted")?;
        ensure!(
            err.to_string()
                .contains(&format!("local port {} is already in use", fwd.local_port)),
            "{err}"
        );

        let err = PortForward::start(
            &client,
            target(ForwardKind::Service, &ns, "web"),
            RemotePort::Number(81),
            LocalPort::Random,
        )
        .await
        .err()
        .context("a missing service port was accepted")?;
        ensure!(
            err.to_string().contains(&format!(
                "service {ns}/web: has no port 81 (ports: 80/http -> web)"
            )),
            "{err}"
        );

        let err = PortForward::start(
            &client,
            target(ForwardKind::Service, &ns, "nope"),
            RemotePort::Number(80),
            LocalPort::Random,
        )
        .await
        .err()
        .context("a missing service was accepted")?;
        ensure!(
            err.to_string()
                .contains(&format!("service {ns}/nope not found")),
            "{err}"
        );
        Ok(())
    })
    .await
}

/// An echo server on port 7000 of pod `echo` (each connection gets its own
/// `cat`), and a forward to it on a random local port.
///
/// `tcpsvd`, not `nc -lk -e cat`: busybox `nc` listens with a backlog of 1,
/// so 20 connections at once overflow its accept queue, the kernel falls
/// back to SYN cookies and now and then resets a connection on its first
/// data. kubectl port-forward and kube-rs's `Portforwarder` lost
/// connections to that server the same way (#316).
async fn start_echo(client: &Client, ns: &str) -> Result<PortForward> {
    let pod: Pod = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": "echo" },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "echo", "image": "busybox:1.36",
                "command": ["tcpsvd", "-b", "64", "-c", "64", "0.0.0.0", "7000", "cat"],
                "ports": [{ "containerPort": 7000 }],
                "readinessProbe": { "exec": { "command": ["true"] }, "periodSeconds": 1 }
            }]
        }
    }))?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    pods.create(&PostParams::default(), &pod).await?;
    eventually("the echo pod is ready", TIMEOUT, || async {
        Ok(pods.get("echo").await.ok().filter(pod_is_ready).map(|_| ()))
    })
    .await?;
    PortForward::start(
        client,
        target(ForwardKind::Pod, ns, "echo"),
        RemotePort::Number(7000),
        LocalPort::Random,
    )
    .await
}

/// Send `payload` on a new connection to `port` while reading the echo
/// back, and return what came back.
async fn echo_through(port: u16, payload: Vec<u8>) -> Result<Vec<u8>> {
    let s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let (mut rd, mut wr) = s.into_split();
    let len = payload.len();
    let writer = tokio::spawn(async move { wr.write_all(&payload).await.map(|_| wr) });
    let mut got = vec![0u8; len];
    tokio::time::timeout(TIMEOUT, rd.read_exact(&mut got))
        .await
        .context("the echo timed out")?
        .context("the connection closed early")?;
    writer.await??;
    Ok(got)
}

/// `len` bytes that differ per `seed` and per position.
fn pattern(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            // xorshift64
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

/// A connection that stays idle for longer than the client's read timeout
/// (295 s) still works afterwards: the forward pings the API server (#304).
#[tokio::test]
#[ignore]
async fn an_idle_forwarded_connection_outlives_the_read_timeout() -> Result<()> {
    let idle = nauvi::READ_TIMEOUT + Duration::from_secs(20);
    in_temp_ns_for(
        "kl-it-pf-idle",
        idle + TIMEOUT * 2,
        |client, ns| async move {
            let fwd = start_echo(&client, &ns).await?;
            let mut conn = tokio::net::TcpStream::connect(("127.0.0.1", fwd.local_port)).await?;
            conn.write_all(b"hello\n").await?;
            let mut got = [0u8; 6];
            tokio::time::timeout(Duration::from_secs(30), conn.read_exact(&mut got))
                .await
                .context("no first echo")??;
            ensure!(&got == b"hello\n", "{:?}", String::from_utf8_lossy(&got));

            tokio::time::sleep(idle).await;
            ensure!(
                fwd.status().connections == 1,
                "the idle connection was closed: {:?}",
                fwd.status()
            );
            conn.write_all(b"still there\n").await?;
            let mut got = [0u8; 12];
            tokio::time::timeout(Duration::from_secs(30), conn.read_exact(&mut got))
                .await
                .context("no echo after the idle time")?
                .context("the connection closed while idle")?;
            ensure!(
                &got == b"still there\n",
                "{:?}",
                String::from_utf8_lossy(&got)
            );
            Ok(())
        },
    )
    .await
}

/// How many connections the `counted` pod's server accepted: it logs a line
/// for each one.
async fn accepts(client: &Client, ns: &str) -> Result<usize> {
    let logs = Api::<Pod>::namespaced(client.clone(), ns)
        .logs("counted", &Default::default())
        .await?;
    Ok(logs.lines().filter(|l| *l == "accepted").count())
}

/// Nothing connects to the pod's port before a local client does (#374):
/// with one upgrade per connection the kubelet dials the port as soon as
/// the upgrade completes, so a tunnel opened ahead of time would be a
/// silent connection to the user's app; with a session (#399) it dials when
/// a connection's streams arrive. For each way of reaching the pod (a
/// WebSocket-tunnelled or plain SPDY session, one upgrade per connection):
/// starting the forward makes no connection in the pod, and each local
/// connection exactly one, also past a keep-warm refresh.
#[tokio::test]
#[ignore]
async fn the_pod_sees_a_connection_only_when_a_client_connects() -> Result<()> {
    in_temp_ns("kl-it-pf-quiet", |client, ns| async move {
        let pod: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "counted" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{
                    "name": "echo", "image": "busybox:1.36",
                    "command": ["tcpsvd", "0.0.0.0", "7000", "sh", "-c", "echo accepted >&2; exec cat"],
                    "ports": [{ "containerPort": 7000 }],
                    "readinessProbe": { "exec": { "command": ["true"] }, "periodSeconds": 1 }
                }]
            }
        }))?;
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        pods.create(&PostParams::default(), &pod).await?;
        eventually("the counted pod is ready", TIMEOUT, || async {
            Ok(pods.get("counted").await.ok().filter(pod_is_ready).map(|_| ()))
        })
        .await?;
        let modes = [Multiplex::Auto, Multiplex::PlainSpdy, Multiplex::Off];
        let mut forwards = Vec::new();
        for mode in modes {
            let fwd = PortForward::start_with(
                &client,
                target(ForwardKind::Pod, &ns, "counted"),
                RemotePort::Number(7000),
                LocalPort::Random,
                mode,
            )
            .await?;
            forwards.push((mode, fwd));
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        let n = accepts(&client, &ns).await?;
        ensure!(n == 0, "{n} connections reached the pod before any client");

        let mut want = 0;
        // Two connections each: the second one is a new stream on the
        // forward's open session.
        for (mode, fwd) in forwards.iter().chain(forwards.iter()) {
            let got = echo_through(fwd.local_port, b"hello\n".to_vec()).await?;
            ensure!(got == b"hello\n", "{mode:?}");
            want += 1;
            let n = eventually("the pod logs the connection", TIMEOUT, || async {
                let n = accepts(&client, &ns).await?;
                Ok((n >= want).then_some(n))
            })
            .await?;
            ensure!(n == want, "{mode:?}: {n} connections for {want} clients");
        }
        // The forwards keep an API-server connection warm, or ping their
        // session: past a refresh, the pod still saw only the clients'.
        tokio::time::sleep(Duration::from_secs(35)).await;
        let n = accepts(&client, &ns).await?;
        ensure!(n == want, "{n} connections after the keep-warm refresh");
        for (mode, fwd) in &forwards {
            ensure!(
                fwd.status().total_connections == 2,
                "{mode:?}: {:?}",
                fwd.status()
            );
        }
        Ok(())
    })
    .await
}

/// A pod deleted and recreated with the same name (a bare pod, or a
/// StatefulSet's) while its forward runs: the forward's session to the old
/// pod only answers with errors, so the forward opens one to the new pod
/// (its UID differs, #399). The first connection after the new pod is ready
/// already works, in each way of reaching the pod.
#[tokio::test]
#[ignore]
async fn a_pod_recreated_with_the_same_name_gets_new_connections() -> Result<()> {
    in_temp_ns("kl-it-pf-again", |client, ns| async move {
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        let create = || async {
            let pod: Pod = serde_json::from_value(serde_json::json!({
                "apiVersion": "v1", "kind": "Pod",
                "metadata": { "name": "again" },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{
                        "name": "echo", "image": "busybox:1.36",
                        "command": ["tcpsvd", "0.0.0.0", "7000", "cat"],
                        "ports": [{ "containerPort": 7000 }],
                        "readinessProbe": { "exec": { "command": ["true"] }, "periodSeconds": 1 }
                    }]
                }
            }))?;
            let uid = pods
                .create(&PostParams::default(), &pod)
                .await?
                .metadata
                .uid;
            eventually("the pod is ready", TIMEOUT, || async {
                Ok(pods
                    .get("again")
                    .await
                    .ok()
                    .filter(pod_is_ready)
                    .map(|_| ()))
            })
            .await?;
            anyhow::Ok(uid)
        };
        let first = create().await?;
        let mut forwards = Vec::new();
        for mode in [Multiplex::Auto, Multiplex::PlainSpdy, Multiplex::Off] {
            let fwd = PortForward::start_with(
                &client,
                target(ForwardKind::Pod, &ns, "again"),
                RemotePort::Number(7000),
                LocalPort::Random,
                mode,
            )
            .await?;
            let got = echo_through(fwd.local_port, b"first\n".to_vec()).await?;
            ensure!(got == b"first\n", "{mode:?}");
            forwards.push((mode, fwd));
        }

        pods.delete("again", &DeleteParams::default()).await?;
        eventually("the old pod is gone", TIMEOUT, || async {
            Ok(pods.get_opt("again").await?.is_none().then_some(()))
        })
        .await?;
        let second = create().await?;
        ensure!(first != second, "the same UID: {first:?}");

        for (mode, fwd) in &forwards {
            for i in 0..3 {
                let got = echo_through(fwd.local_port, b"again\n".to_vec())
                    .await
                    .with_context(|| format!("{mode:?}: connection {i} to the new pod"))?;
                ensure!(got == b"again\n", "{mode:?}: connection {i}");
            }
            let st = fwd.status();
            ensure!(st.last_error.is_empty(), "{mode:?}: {st:?}");
        }
        Ok(())
    })
    .await
}

/// 10 MB goes through the forward and back unchanged (#304: our own
/// port-forward protocol code).
#[tokio::test]
#[ignore]
async fn ten_megabytes_round_trip_byte_for_byte() -> Result<()> {
    in_temp_ns("kl-it-pf-big", |client, ns| async move {
        let fwd = start_echo(&client, &ns).await?;
        let sent = pattern(304, 10 * 1024 * 1024);
        let got = echo_through(fwd.local_port, sent.clone()).await?;
        if let Some(i) = sent.iter().zip(&got).position(|(a, b)| a != b) {
            bail!("the echo differs at byte {i} of {}", sent.len());
        }
        ensure!(got.len() == sent.len());
        Ok(())
    })
    .await
}

/// 20 connections through one forward at once, each with its own payload,
/// each getting back exactly its own bytes.
#[tokio::test]
#[ignore]
async fn twenty_parallel_connections_each_get_their_own_echo() -> Result<()> {
    in_temp_ns("kl-it-pf-par", |client, ns| async move {
        let fwd = start_echo(&client, &ns).await?;
        let port = fwd.local_port;
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..20u64 {
            tasks.spawn(async move {
                // Different sizes too, from 64 KiB to ~1.3 MiB.
                let sent = pattern(i, 64 * 1024 * (1 + i as usize));
                let got = echo_through(port, sent.clone()).await?;
                ensure!(got == sent, "connection {i} got another echo");
                Ok::<_, anyhow::Error>(())
            });
        }
        while let Some(r) = tasks.join_next().await {
            r??;
        }
        let st = fwd.status();
        ensure!(st.total_connections >= 20, "{st:?}");
        ensure!(st.last_error.is_empty(), "{st:?}");
        Ok(())
    })
    .await
}

/// p50 and p90 of `times`, in ms.
fn percentiles(times: &mut [Duration]) -> (f64, f64) {
    times.sort();
    let at = |q: f64| {
        let i = ((times.len() as f64 * q).ceil() as usize).clamp(1, times.len()) - 1;
        times[i].as_secs_f64() * 1000.0
    };
    (at(0.5), at(0.9))
}

/// One HTTP request on a new connection, timed from connect to the last
/// byte of the body (as `curl -w %{time_total}`): not to the server's close,
/// which takes about a second to come back through the API server, for
/// kubectl as well.
async fn timed_get(port: u16) -> Result<Duration> {
    let t = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        s.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = s.read(&mut buf).await?;
            ensure!(n > 0, "closed early: {}", String::from_utf8_lossy(&got));
            got.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&got);
            let Some(end) = text.find("\r\n\r\n") else {
                continue;
            };
            ensure!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
            let len: usize = text[..end]
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().to_string())
                })
                .context("no Content-Length")?
                .parse()?;
            if got.len() >= end + 4 + len {
                return Ok(());
            }
        }
    })
    .await
    .context("http request timed out")??;
    Ok(t.elapsed())
}

/// `kubectl port-forward` to port 80 of `pod` on a free local port, or
/// `None` without kubectl.
async fn kubectl_forward(ns: &str, pod: &str) -> Result<Option<(tokio::process::Child, u16)>> {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    let child = tokio::process::Command::new("kubectl")
        .args(["--context", &ctx, "-n", ns, "port-forward"])
        .args(["--address", "127.0.0.1"])
        .arg(format!("pod/{pod}"))
        .arg(":80")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let stdout = child.stdout.take().context("kubectl stdout")?;
    let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
    let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
        .await
        .context("kubectl port-forward did not start")??
        .context("kubectl port-forward exited")?;
    // "Forwarding from 127.0.0.1:41235 -> 80"
    let port = line
        .split_whitespace()
        .nth(2)
        .and_then(|a| a.rsplit(':').next())
        .and_then(|p| p.parse().ok())
        .with_context(|| format!("unexpected kubectl output: {line}"))?;
    // Keep reading, so kubectl never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok(Some((child, port)))
}

/// How much slower than kubectl's a new connection's p50 may be, in ms,
/// when it is a new stream on the forward's session (#399), as kubectl's.
const KUBECTL_MARGIN_MS: f64 = 5.0;
/// The same, with one upgrade per connection (the fallback, #374): the API
/// server and kubelet take ~15 ms to set up each upgrade on kind, plus
/// slack for CI.
const PER_CONNECTION_MARGIN_MS: f64 = 30.0;

/// New connections through a forward (#374, #399): 50 sequential requests,
/// each on its own connection, alternating with the same requests through
/// `kubectl port-forward` to the same pod. All of them succeed, and the p50
/// stays within [`KUBECTL_MARGIN_MS`] of kubectl's for multiplexed
/// forwards (WebSocket-tunnelled SPDY, plain SPDY, a Service), within
/// [`PER_CONNECTION_MARGIN_MS`] with one upgrade per connection.
///
/// Before #374 each new connection also waited ~40 ms for Nagle (TCP_NODELAY
/// off) and made its own TCP and TLS handshakes: 56 ms against kubectl's
/// 4 ms; after it, one upgrade per connection took 16 ms. A stream on an
/// open session takes about as long as kubectl's: 2.8 ms against 3.4 ms.
#[tokio::test]
#[ignore]
async fn new_connections_are_close_to_kubectl() -> Result<()> {
    const N: usize = 50;
    in_temp_ns("kl-it-pf-lat", |client, ns| async move {
        create_web(&client, &ns).await?;
        let pod = ready_pods(&client, &ns).await?.remove(0);
        let pod_forward = |mode| {
            let client = client.clone();
            let target = target(ForwardKind::Pod, &ns, &pod);
            async move {
                PortForward::start_with(
                    &client,
                    target,
                    RemotePort::Number(80),
                    LocalPort::Random,
                    mode,
                )
                .await
            }
        };
        let pod_fwd = pod_forward(Multiplex::Auto).await?;
        let spdy_fwd = pod_forward(Multiplex::PlainSpdy).await?;
        let v4_fwd = pod_forward(Multiplex::Off).await?;
        let svc = target(ForwardKind::Service, &ns, "web");
        let svc_fwd = eventually("service forward starts", TIMEOUT, || async {
            match PortForward::start_with(
                &client,
                svc.clone(),
                RemotePort::Number(80),
                LocalPort::Random,
                Multiplex::Auto,
            )
            .await
            {
                Ok(f) => Ok(Some(f)),
                Err(e) if e.to_string().contains("no ready pod") => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await?;
        let kubectl = kubectl_forward(&ns, &pod).await?;
        let mut ports = vec![
            ("pod", pod_fwd.local_port),
            ("service", svc_fwd.local_port),
            ("pod/spdy", spdy_fwd.local_port),
            ("pod/v4", v4_fwd.local_port),
        ];
        if let Some((_, port)) = &kubectl {
            ports.push(("kubectl", *port));
        }
        // Warm up: the first requests pay for nginx and kubectl starting.
        for (_, port) in &ports {
            for _ in 0..3 {
                timed_get(*port).await?;
            }
        }
        let mut times: Vec<Vec<Duration>> = vec![Vec::new(); ports.len()];
        for _ in 0..N {
            for (i, (_, port)) in ports.iter().enumerate() {
                times[i].push(timed_get(*port).await?);
            }
        }
        let mut stats = Vec::new();
        for ((name, _), t) in ports.iter().zip(times.iter_mut()) {
            let (p50, p90) = percentiles(t);
            println!("{name:8} p50 {p50:6.1} ms  p90 {p90:6.1} ms  ({N} new connections)");
            stats.push((*name, p50));
        }
        for f in [&pod_fwd, &svc_fwd, &spdy_fwd, &v4_fwd] {
            let st = f.status();
            ensure!(st.total_connections as usize >= N + 3, "{st:?}");
            ensure!(st.last_error.is_empty(), "{st:?}");
        }
        // Without kubectl, a fixed budget that an upgrade per connection
        // (or a Nagle stall) would break.
        let kubectl_p50 = stats.iter().find(|s| s.0 == "kubectl").map(|s| s.1);
        for (name, p50) in stats.iter().filter(|s| s.0 != "kubectl") {
            let margin = if *name == "pod/v4" {
                PER_CONNECTION_MARGIN_MS
            } else {
                KUBECTL_MARGIN_MS
            };
            let budget = kubectl_p50.unwrap_or(5.0) + margin;
            ensure!(
                *p50 <= budget,
                "{name} forward: p50 {p50:.1} ms over the budget of {budget:.1} ms"
            );
        }
        Ok(())
    })
    .await
}
