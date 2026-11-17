//! #180: a watch whose connection drops (a VPN or SSH tunnel that closes)
//! must go Live again by itself once the API server can be reached again,
//! without any change in the cluster. `#[ignore]`d like `cluster.rs`; run
//! with `cargo test --test reconnect -- --ignored`.
//!
//! The client talks to the kind API server through a TCP proxy on a local
//! port that the test closes (every connection with it, then the port
//! refuses) and opens again on the same port.

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use futures::stream::BoxStream;
use futures::StreamExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{Api, DeleteParams, PostParams};
use kube::config::KubeConfigOptions;
use kube::Client;
use nauvi::liveness::Prober;
use nauvi::watch::{watch_with, Update, WatchState};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

fn context() -> String {
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string())
}

/// Listen on 127.0.0.1:`port` (0: any free port), reusing the address so
/// the same port can be bound again right after it was closed.
fn bind(port: u16) -> Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(SocketAddr::from(([127, 0, 0, 1], port)))?;
    Ok(socket.listen(64)?)
}

/// Forward every connection to `upstream`. Aborting the task closes the
/// port and every connection through it (the JoinSet aborts them when it is
/// dropped).
fn serve(listener: TcpListener, upstream: SocketAddr) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut conns = JoinSet::new();
        while let Ok((mut down, _)) = listener.accept().await {
            conns.spawn(async move {
                if let Ok(mut up) = TcpStream::connect(upstream).await {
                    let _ = tokio::io::copy_bidirectional(&mut down, &mut up).await;
                }
            });
        }
    })
}

/// The next state update, skipping objects; fails after `within`.
async fn next_state(
    updates: &mut BoxStream<'static, Update<String>>,
    within: Duration,
) -> Result<WatchState> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, updates.next()).await {
            Err(_) => bail!("no state change within {within:?}"),
            Ok(None) => bail!("the watch ended"),
            Ok(Some(Update::State(s))) => return Ok(s),
            Ok(Some(_)) => {}
        }
    }
}

/// Wait for `want` (by variant), failing on Forbidden or after `within`.
async fn wait_state(
    updates: &mut BoxStream<'static, Update<String>>,
    within: Duration,
    want: fn(&WatchState) -> bool,
) -> Result<WatchState> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let s = next_state(updates, left).await?;
        if want(&s) {
            return Ok(s);
        }
        if let WatchState::Forbidden { error } = &s {
            bail!("forbidden: {error}");
        }
    }
}

#[tokio::test]
#[ignore]
async fn a_dropped_connection_goes_live_again_without_a_change() -> Result<()> {
    let mut config = kube::Config::from_kubeconfig(&KubeConfigOptions {
        context: Some(context()),
        ..Default::default()
    })
    .await?;
    let host = config.cluster_url.host().context("no host")?.to_string();
    let port = config.cluster_url.port_u16().unwrap_or(443);
    let upstream = tokio::net::lookup_host((host.as_str(), port))
        .await?
        .next()
        .context("cannot resolve the API server")?;

    // The namespace first, straight to the API server: nothing to stop if
    // it cannot be made.
    let direct = nauvi::client_for_context(Some(&context())).await?;
    let ns = format!("reconnect-{:x}", common::unique_suffix());
    let namespaces: Api<Namespace> = Api::all(direct.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;

    let listener = bind(0)?;
    let proxy_port = listener.local_addr()?.port();
    let mut proxy = serve(listener, upstream);
    // kind's certificate is valid for 127.0.0.1.
    let server = format!("https://127.0.0.1:{proxy_port}");
    config.cluster_url = server.parse()?;
    config.proxy_url = None;

    let result = async {
        let client = Client::try_from(config)?;
        let prober = Prober::for_server(client.clone(), &server);
        let api: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);
        let (_store, mut updates) = watch_with(api, &prober, (), |cm: &ConfigMap| {
            cm.metadata.name.clone().unwrap_or_default()
        });
        wait_state(&mut updates, Duration::from_secs(60), |s| {
            *s == WatchState::Live
        })
        .await
        .context("live at first")?;

        // The path drops: open connections close, new ones are refused.
        proxy.abort();
        let _ = (&mut proxy).await;
        let lost = wait_state(&mut updates, Duration::from_secs(30), |s| {
            matches!(s, WatchState::Reconnecting { .. })
        })
        .await
        .context("Reconnecting after the drop")?;
        assert_eq!(
            lost,
            WatchState::Reconnecting {
                error: format!("Lost the connection to the cluster ({server}); retrying.")
            }
        );

        // Down long enough for the retries to back off a few times.
        tokio::time::sleep(Duration::from_secs(15)).await;
        proxy = serve(bind(proxy_port)?, upstream);
        let back = Instant::now();
        // Nothing changes in the namespace: only a new list can say Live.
        wait_state(&mut updates, Duration::from_secs(25), |s| {
            *s == WatchState::Live
        })
        .await
        .context("Live again after the path came back (#180)")?;
        println!("Live again {:?} after the path came back", back.elapsed());
        anyhow::Ok(())
    }
    .await;

    // Delete through the direct client: the proxy may be down.
    proxy.abort();
    let _ = namespaces.delete(&ns, &DeleteParams::default()).await;
    result
}
