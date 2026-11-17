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
    client_for_context, pod_is_ready, ForwardKind, ForwardTarget, LocalPort, PortForward,
    RemotePort,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TIMEOUT: Duration = Duration::from_secs(120);

async fn connect() -> Result<Client> {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
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
