//! `kubeloupe mcp` driven over stdio, as an MCP client drives it (#298).
//!
//! The protocol tests need no cluster: the server connects on the first
//! tool call, so `initialize` and `tools/list` work with a missing
//! kubeconfig. The `#[ignore]`d ones run against the kind cluster
//! (`KUBELOUPE_TEST_CONTEXT`, default `kind-kubeloupe-test`) in a temporary
//! namespace.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use k8s_openapi::api::core::v1::{Namespace, Pod, Secret};
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use serde_json::{json, Value};

const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

fn context() -> String {
    std::env::var("KUBELOUPE_TEST_CONTEXT").unwrap_or_else(|_| "kind-kubeloupe-test".into())
}

/// A running `kubeloupe mcp` and a reader thread for its stdout lines.
struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl Server {
    fn start(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kubeloupe"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start kubeloupe mcp");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
            next_id: 1,
        }
    }

    /// A server for the test cluster.
    fn on_cluster(extra: &[&str]) -> Self {
        let ctx = context();
        let mut args = vec!["--context", ctx.as_str(), "mcp"];
        args.extend_from_slice(extra);
        let mut s = Self::start(&args);
        s.initialize();
        s
    }

    fn send(&mut self, msg: &Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    }

    /// The next stdout line, which must be one JSON-RPC message.
    fn read(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(REPLY_TIMEOUT)
            .expect("no reply from the server");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"))
    }

    /// Send a request and return its response.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let msg = self.read();
            if msg["id"] == id {
                assert_eq!(msg["jsonrpc"], "2.0", "{msg}");
                return msg;
            }
            // A notification from the server: not what we wait for.
            assert!(msg.get("id").is_none(), "reply to another request: {msg}");
        }
    }

    fn initialize(&mut self) -> Value {
        let reply = self.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "kubeloupe-tests", "version": "1" }
            }),
        );
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        reply
    }

    fn tool_names(&mut self) -> Vec<String> {
        let reply = self.request("tools/list", json!({}));
        reply["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// Call a tool: (is_error, text).
    fn call(&mut self, name: &str, arguments: Value) -> (bool, String) {
        let reply = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        let result = &reply["result"];
        assert!(result.is_object(), "{reply}");
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        (result["isError"] == true, text)
    }

    /// Call a tool that must succeed.
    fn ok(&mut self, name: &str, arguments: Value) -> String {
        let (err, text) = self.call(name, arguments.clone());
        assert!(!err, "{name} {arguments} failed: {text}");
        text
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // Closing stdin ends the server.
        drop(self.stdin.take());
        for _ in 0..50 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn offline(extra: &[&str]) -> Server {
    let mut args = vec!["--kubeconfig", "/nonexistent/kubeconfig", "mcp"];
    args.extend_from_slice(extra);
    Server::start(&args)
}

#[test]
fn initialize_lists_the_server_and_its_tools_capability() {
    let mut s = offline(&[]);
    let reply = s.initialize();
    let r = &reply["result"];
    assert_eq!(r["serverInfo"]["name"], "kubeloupe", "{reply}");
    assert_eq!(r["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(r["protocolVersion"], "2025-06-18", "{reply}");
    assert!(r["capabilities"]["tools"].is_object(), "{reply}");
    assert!(
        r["instructions"].as_str().unwrap().contains("read-only"),
        "{reply}"
    );
    // ping works after the handshake.
    let pong = s.request("ping", json!({}));
    assert!(pong["result"].is_object(), "{pong}");
}

#[test]
fn tools_are_read_only_unless_writes_are_allowed() {
    let mut s = offline(&[]);
    s.initialize();
    assert_eq!(
        s.tool_names(),
        ["list", "get", "describe", "logs", "events", "top"]
    );
    let reply = s.request("tools/list", json!({}));
    for t in reply["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["annotations"]["readOnlyHint"], true, "{t}");
        assert_eq!(t["inputSchema"]["type"], "object", "{t}");
    }

    let mut w = offline(&["--allow-writes"]);
    w.initialize();
    let names = w.tool_names();
    assert_eq!(&names[6..], ["scale", "restart", "delete", "apply"]);
}

#[test]
fn write_tools_are_refused_without_the_flag() {
    let mut s = offline(&[]);
    s.initialize();
    for tool in ["scale", "restart", "delete", "apply"] {
        let (err, text) = s.call(tool, json!({ "kind": "deploy/web" }));
        assert!(err, "{tool}: {text}");
        assert!(text.contains("--allow-writes"), "{tool}: {text}");
    }
    let (err, text) = s.call("exec", json!({}));
    assert!(err && text.contains("unknown tool"), "{text}");
}

#[test]
fn a_missing_kubeconfig_is_a_tool_error_not_a_crash() {
    let mut s = offline(&[]);
    s.initialize();
    let (err, text) = s.call("list", json!({ "kind": "pods" }));
    assert!(err, "{text}");
    assert!(text.to_lowercase().contains("kubeconfig"), "{text}");
    // The server is still there.
    assert_eq!(s.tool_names().len(), 6);
}

#[test]
fn unknown_methods_get_a_json_rpc_error() {
    let mut s = offline(&[]);
    s.initialize();
    let reply = s.request("no/such/method", json!({}));
    assert!(reply["error"]["code"].is_i64(), "{reply}");
}

// ---------------------------------------------------------------------------
// Against the kind cluster.
// ---------------------------------------------------------------------------

async fn connect() -> Result<Client> {
    tokio::time::timeout(
        Duration::from_secs(20),
        kubeloupe::client_for_context(Some(&context())),
    )
    .await
    .context("timed out building client")?
}

async fn temp_ns(client: &Client, prefix: &str) -> Result<String> {
    let suffix = std::process::id() ^ jiff::Timestamp::now().subsec_microsecond() as u32;
    let ns = format!("{prefix}-{suffix:x}");
    let obj: Namespace = serde_json::from_value(json!({ "metadata": { "name": ns } }))?;
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &obj)
        .await?;
    Ok(ns)
}

async fn drop_ns(client: &Client, ns: &str) {
    let _ = Api::<Namespace>::all(client.clone())
        .delete(ns, &DeleteParams::background())
        .await;
}

const SECRET_VALUE: &str = "hunter2-mcp-298";

async fn fixtures(client: &Client, ns: &str) -> Result<()> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(SECRET_VALUE);
    let secret: Secret = serde_json::from_value(json!({
        "metadata": {
            "name": "creds",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration":
                    format!("{{\"stringData\":{{\"password\":\"{SECRET_VALUE}\"}}}}")
            }
        },
        "data": { "password": encoded }
    }))?;
    Api::<Secret>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &secret)
        .await?;
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": "talker", "labels": { "app": "talker" } },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "c", "image": "busybox:1.36",
                "command": ["sh", "-c", "for i in $(seq 1 50); do echo line-$i; done; sleep 3600"]
            }]
        }
    }))?;
    Api::<Pod>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &pod)
        .await?;
    Ok(())
}

/// Poll a tool until its text satisfies `ok`.
fn wait_for(s: &mut Server, tool: &str, args: Value, ok: impl Fn(&str) -> bool) -> Result<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let (err, text) = s.call(tool, args.clone());
        if !err && ok(&text) {
            return Ok(text);
        }
        if std::time::Instant::now() > deadline {
            bail!("{tool} {args}: still {text}");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn read_tools_on_cluster(s: &mut Server, ns: &str) -> Result<()> {
    // Secrets: keys, never values, and last-applied redacted.
    let yaml = s.ok("get", json!({ "kind": "secret/creds", "namespace": ns }));
    assert!(yaml.contains("password: <redacted>"), "{yaml}");
    assert!(
        yaml.contains("last-applied-configuration: <redacted>"),
        "{yaml}"
    );
    assert!(!yaml.contains(SECRET_VALUE), "{yaml}");
    assert!(!yaml.contains("aHVudGVy"), "{yaml}");
    assert!(!yaml.contains("managedFields"), "{yaml}");
    let described = s.ok(
        "describe",
        json!({ "kind": "secret", "name": "creds", "namespace": ns }),
    );
    assert!(described.contains("password: 15 bytes"), "{described}");
    assert!(!described.contains(SECRET_VALUE), "{described}");
    let listed = s.ok("list", json!({ "kind": "secrets", "namespace": ns }));
    assert!(
        listed.contains("creds") && !listed.contains(SECRET_VALUE),
        "{listed}"
    );

    // Logs: the tail, capped by `tail`.
    let logs = wait_for(
        s,
        "logs",
        json!({ "target": "talker", "namespace": ns, "tail": 5 }),
        |t| t.contains("line-50"),
    )?;
    assert_eq!(
        logs.lines().collect::<Vec<_>>(),
        ["line-46", "line-47", "line-48", "line-49", "line-50"],
        "{logs}"
    );

    // list honours limit and says more exist.
    let one = s.ok(
        "list",
        json!({ "kind": "pods", "namespace": "demo", "limit": 1 }),
    );
    assert_eq!(one.lines().count(), 3, "{one}");
    assert!(one.contains("[more objects exist"), "{one}");

    // Events of the pod (scheduled, pulled, started ...).
    wait_for(
        s,
        "events",
        json!({ "namespace": ns, "kind": "pod", "name": "talker" }),
        |t| t.contains("pod/talker"),
    )?;
    let (err, text) = s.call("get", json!({ "kind": "pod/nope", "namespace": ns }));
    assert!(err && text.contains("not found"), "{text}");
    Ok(())
}

#[tokio::test]
#[ignore]
async fn mcp_read_tools_on_the_cluster() -> Result<()> {
    let client = connect().await?;
    let ns = temp_ns(&client, "it-mcp").await?;
    let result = async {
        fixtures(&client, &ns).await?;
        let mut s = Server::on_cluster(&[]);
        let r = read_tools_on_cluster(&mut s, &ns);
        // Writes stay off.
        let (err, text) = s.call("delete", json!({ "kind": "pod/talker", "namespace": ns }));
        assert!(err && text.contains("--allow-writes"), "{text}");
        r
    }
    .await;
    drop_ns(&client, &ns).await;
    result
}

#[tokio::test]
#[ignore]
async fn mcp_write_tools_on_the_cluster() -> Result<()> {
    let client = connect().await?;
    let ns = temp_ns(&client, "it-mcp-w").await?;
    let result = async {
        let mut s = Server::on_cluster(&["--allow-writes"]);
        let manifest =
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-mcp\ndata:\n  k: v\n";
        let dry = s.ok(
            "apply",
            json!({ "manifest": manifest, "namespace": ns, "dry_run": true }),
        );
        assert_eq!(dry.trim(), "configmap/from-mcp created (dry run)");
        let (err, _) = s.call("get", json!({ "kind": "cm/from-mcp", "namespace": ns }));
        assert!(err, "a dry run stored the ConfigMap");
        let applied = s.ok("apply", json!({ "manifest": manifest, "namespace": ns }));
        assert_eq!(applied.trim(), "configmap/from-mcp created");
        let yaml = s.ok("get", json!({ "kind": "cm/from-mcp", "namespace": ns }));
        assert!(yaml.contains("k: v"), "{yaml}");
        // Scale only applies to workloads.
        let (err, text) = s.call(
            "scale",
            json!({ "kind": "cm/from-mcp", "namespace": ns, "replicas": 2 }),
        );
        assert!(err && text.contains("does not apply"), "{text}");
        let deleted = s.ok("delete", json!({ "kind": "cm/from-mcp", "namespace": ns }));
        assert!(deleted.starts_with("Deleted ConfigMap"), "{deleted}");
        let (err, text) = s.call("apply", json!({ "manifest": "kind: [", "namespace": ns }));
        assert!(err, "{text}");
        Ok(())
    }
    .await;
    drop_ns(&client, &ns).await;
    result
}

/// RBAC applies: the limited user (`edit` in team-a only) may not read
/// kube-system's Secrets or delete there. Skips unless
/// `KUBELOUPE_LIMITED_KUBECONFIG` is set (scripts/test-cluster/limited-user.sh).
#[test]
#[ignore]
fn mcp_limited_user_is_bound_by_rbac() {
    let Ok(kubeconfig) = std::env::var("KUBELOUPE_LIMITED_KUBECONFIG") else {
        eprintln!("skipped: KUBELOUPE_LIMITED_KUBECONFIG is not set");
        return;
    };
    let mut s = Server::start(&["--kubeconfig", &kubeconfig, "mcp", "--allow-writes"]);
    s.initialize();
    let (err, text) = s.call(
        "list",
        json!({ "kind": "secrets", "namespace": "kube-system" }),
    );
    assert!(err && text.contains("forbidden"), "{text}");
    let (err, text) = s.call(
        "delete",
        json!({ "kind": "deploy/coredns", "namespace": "kube-system" }),
    );
    assert!(err && text.contains("Not allowed"), "{text}");
}
