//! `nauvi mcp` driven over stdio, as an MCP client drives it (#298).
//!
//! The protocol tests need no cluster: the server connects on the first
//! tool call, so `initialize` and `tools/list` work with a missing
//! kubeconfig. The `#[ignore]`d ones run against the kind cluster
//! (`NAUVI_TEST_CONTEXT`, default `kind-nauvi-test`) in a temporary
//! namespace.

mod common;

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
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".into())
}

/// A running `nauvi mcp` and a reader thread for its stdout lines.
struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl Server {
    fn start(args: &[&str]) -> Self {
        // Not the developer's own app settings: a context they marked
        // read-only or protected there would refuse the write tools (#338).
        let config = std::env::temp_dir().join(format!("nauvi-mcp-cfg-{}", std::process::id()));
        Self::start_with_config(args, &config)
    }

    /// A server that reads the app's settings from `config/com.nauvi.app`
    /// (Linux: `XDG_CONFIG_HOME`).
    fn start_with_config(args: &[&str], config: &std::path::Path) -> Self {
        Self::start_with_env(args, config, &[])
    }

    /// [`Self::start_with_config`] with extra environment variables.
    fn start_with_env(args: &[&str], config: &std::path::Path, env: &[(&str, &str)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_nauvi"))
            .args(args)
            .envs(env.iter().copied())
            .env("XDG_CONFIG_HOME", config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start nauvi mcp");
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
                "clientInfo": { "name": "nauvi-tests", "version": "1" }
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
    assert_eq!(r["serverInfo"]["name"], "nauvi", "{reply}");
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
        ["list", "get", "describe", "logs", "events", "problems", "top"]
    );
    let reply = s.request("tools/list", json!({}));
    for t in reply["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["annotations"]["readOnlyHint"], true, "{t}");
        assert_eq!(t["inputSchema"]["type"], "object", "{t}");
    }

    let mut w = offline(&["--allow-writes"]);
    w.initialize();
    let names = w.tool_names();
    assert_eq!(&names[7..], ["scale", "restart", "delete", "apply"]);
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
    assert_eq!(s.tool_names().len(), 7);
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
        nauvi::client_for_context(Some(&context())),
    )
    .await
    .context("timed out building client")?
}

async fn temp_ns(client: &Client, prefix: &str) -> Result<String> {
    let suffix = common::unique_suffix();
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

/// Write tools follow the app's per-context mode (#338): refused on a
/// read-only or protected context, as the app's settings file says, before
/// anything reaches the cluster. Linux only (the file is found through
/// `XDG_CONFIG_HOME`).
#[tokio::test]
#[ignore]
async fn mcp_write_tools_follow_the_context_mode() -> Result<()> {
    if !cfg!(target_os = "linux") {
        eprintln!("skipped: the app's settings are found through XDG_CONFIG_HOME on Linux");
        return Ok(());
    }
    let client = connect().await?;
    let ns = temp_ns(&client, "it-mcp-mode").await?;
    let result = async {
        let ctx = context();
        let manifest =
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-mcp\ndata:\n  k: v\n";
        for (mode, words) in [
            ("readOnly", "is read-only"),
            ("protected", "is protected"),
            ("bogus", "is read-only"),
        ] {
            let config =
                std::env::temp_dir().join(format!("nauvi-mcp-mode-{}-{mode}", std::process::id()));
            let dir = config.join("com.nauvi.app");
            std::fs::create_dir_all(&dir)?;
            let settings = json!({ "contexts": { ctx.clone(): { "mode": mode } } });
            std::fs::write(dir.join("settings.json"), settings.to_string())?;
            let mut s = Server::start_with_config(
                &["--context", ctx.as_str(), "mcp", "--allow-writes"],
                &config,
            );
            s.initialize();
            let (err, text) = s.call("apply", json!({ "manifest": manifest, "namespace": ns }));
            assert!(err && text.contains(words), "{mode}: {text}");
            let (err, text) = s.call("delete", json!({ "kind": "cm/x", "namespace": ns }));
            assert!(err && text.contains(words), "{mode}: {text}");
            // Reads still work.
            s.ok("list", json!({ "kind": "configmaps", "namespace": ns }));
            let _ = std::fs::remove_dir_all(&config);
        }
        let cms: Api<k8s_openapi::api::core::v1::ConfigMap> = Api::namespaced(client.clone(), &ns);
        assert!(
            cms.get_opt("from-mcp").await?.is_none(),
            "a refused apply stored it"
        );
        Ok(())
    }
    .await;
    drop_ns(&client, &ns).await;
    result
}

/// With `--kubeconfig` or `KUBECONFIG`, the mode is matched by the source
/// the app stored with it (file and context), not by the app's id for the
/// context (security review of #338). A file the app's catalog does not
/// have, with no stored mode, refuses writes. Linux only (`XDG_CONFIG_HOME`).
#[tokio::test]
#[ignore]
async fn mcp_mode_of_a_non_default_kubeconfig() -> Result<()> {
    if !cfg!(target_os = "linux") {
        eprintln!("skipped: the app's settings are found through XDG_CONFIG_HOME on Linux");
        return Ok(());
    }
    let client = connect().await?;
    let ns = temp_ns(&client, "it-mcp-kc").await?;
    let result = async {
        let ctx = context();
        let dir = std::env::temp_dir().join(format!("nauvi-mcp-kc-{}", std::process::id()));
        let app = dir.join("cfg").join("com.nauvi.app");
        std::fs::create_dir_all(&app)?;
        // A copy of the test kubeconfig, added in the app.
        let kc = kube::config::Kubeconfig::read()?;
        let work = dir.join("work.yaml");
        let stray = dir.join("stray.yaml");
        std::fs::write(&work, serde_yaml::to_string(&kc)?)?;
        std::fs::write(&stray, serde_yaml::to_string(&kc)?)?;
        let work_str = work.display().to_string();
        // The mode is stored with its source (file and context), under
        // whatever id the app gave it: the CLI matches the source.
        let source = nauvi::context_mode::ModeSource::new(&work, &ctx);
        let mut contexts = serde_json::Map::new();
        contexts.insert(
            format!("{ctx} (work.yaml)"),
            json!({ "mode": "readOnly", "mode_source": source }),
        );
        let settings = json!({ "kubeconfig_sources": [work_str], "contexts": contexts });
        std::fs::write(app.join("settings.json"), settings.to_string())?;
        let manifest =
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-mcp\ndata:\n  k: v\n";
        let config = dir.join("cfg");
        for (file, words) in [
            (&work, "is read-only"),
            (&stray, "not in nauvi's cluster catalog"),
        ] {
            let file = file.display().to_string();
            let mut s = Server::start_with_config(
                &[
                    "--kubeconfig",
                    &file,
                    "--context",
                    &ctx,
                    "mcp",
                    "--allow-writes",
                ],
                &config,
            );
            s.initialize();
            let (err, text) = s.call("apply", json!({ "manifest": manifest, "namespace": ns }));
            assert!(err && text.contains(words), "{file}: {text}");
            s.ok("list", json!({ "kind": "configmaps", "namespace": ns }));
        }
        // KUBECONFIG = the added file: the CLI calls the context `ctx`, the
        // app by the added file's id; the stored source matches.
        let mut s = Server::start_with_env(
            &["--context", &ctx, "mcp", "--allow-writes"],
            &config,
            &[("KUBECONFIG", work_str.as_str())],
        );
        s.initialize();
        let (err, text) = s.call("apply", json!({ "manifest": manifest, "namespace": ns }));
        assert!(
            err && text.contains("is read-only"),
            "KUBECONFIG={work_str}: {text}"
        );
        let cms: Api<k8s_openapi::api::core::v1::ConfigMap> = Api::namespaced(client.clone(), &ns);
        assert!(
            cms.get_opt("from-mcp").await?.is_none(),
            "a refused apply stored it"
        );
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
    .await;
    drop_ns(&client, &ns).await;
    result
}

/// RBAC applies: the limited user (`edit` in team-a only) may not read
/// kube-system's Secrets or delete there. Skips unless
/// `NAUVI_LIMITED_KUBECONFIG` is set (scripts/test-cluster/limited-user.sh).
#[test]
#[ignore]
fn mcp_limited_user_is_bound_by_rbac() {
    let Ok(kubeconfig) = std::env::var("NAUVI_LIMITED_KUBECONFIG") else {
        eprintln!("skipped: NAUVI_LIMITED_KUBECONFIG is not set");
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

/// What `problems` must find (#377): a crash loop, an OOM kill with its
/// limit, a failed Job and a Deployment short of ready replicas; a healthy
/// pod never appears. `hog` restarts: the runtime sometimes reports a
/// memory kill as `Error (exit 137)`, so the test waits for a run that
/// reports `OOMKilled` (#403).
const PROBLEM_FIXTURES: &str = r#"
apiVersion: v1
kind: Pod
metadata: { name: crasher }
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - { name: c, image: "busybox:1.36", command: ["sh", "-c", "echo boom; exit 3"] }
---
apiVersion: v1
kind: Pod
metadata: { name: hog }
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: c
      image: "busybox:1.36"
      command: ["tail", "/dev/zero"]
      resources: { limits: { memory: 16Mi } }
---
apiVersion: v1
kind: Pod
metadata: { name: healthy }
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - { name: c, image: "busybox:1.36", command: ["sleep", "3600"] }
---
apiVersion: batch/v1
kind: Job
metadata: { name: doomed }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 0
      containers:
        - { name: c, image: "busybox:1.36", command: ["sh", "-c", "exit 1"] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: never-ready }
spec:
  replicas: 1
  selector: { matchLabels: { app: never-ready } }
  template:
    metadata: { labels: { app: never-ready } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: c
          image: "busybox:1.36"
          command: ["sleep", "3600"]
          readinessProbe: { exec: { command: ["false"] }, periodSeconds: 2 }
"#;

/// The line of a `problems` table whose NAME column is `name`.
fn problem_line(text: &str, name: &str) -> String {
    text.lines()
        .find(|l| l.split_whitespace().nth(2) == Some(name))
        .unwrap_or_default()
        .to_string()
}

/// `(kind, name, problem)` of each row of a `problems` table, sorted.
fn problem_rows(text: &str) -> Vec<(String, String, String)> {
    let mut rows: Vec<_> = text
        .lines()
        .skip(1)
        .take_while(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let w: Vec<_> = l.split_whitespace().collect();
            (w.len() >= 4).then(|| (w[0].to_string(), w[2].to_string(), w[3].to_string()))
        })
        .collect();
    rows.sort();
    rows
}

/// `nauvi <args>` on the test cluster: (success, stdout, stderr).
fn run_cli(args: &[&str]) -> Result<(bool, String, String)> {
    let out = Command::new(env!("CARGO_BIN_EXE_nauvi"))
        .args(["--context", &context()])
        .args(args)
        .output()?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// `nauvi problems -n <ns>` and the `problems` tool list the same rows.
fn cli_problems_match(s: &mut Server, ns: &str) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let (ok, cli, err) = run_cli(&["problems", "-n", ns])?;
        assert!(ok, "nauvi problems: {err}");
        let tool = s.ok("problems", json!({ "namespace": ns }));
        if problem_rows(&cli) == problem_rows(&tool) {
            assert!(cli.starts_with("KIND"), "{cli}");
            assert!(problem_rows(&cli).len() >= 4, "{cli}");
            assert!(
                cli.ends_with(&format!("in {ns})\n")) && cli.contains("(checked pods, deployments"),
                "{cli}"
            );
            // Kinds narrow it as in the tool; an unknown kind is an error.
            let (_, jobs, _) = run_cli(&["problems", "-n", ns, "-k", "job"])?;
            assert!(
                jobs.contains("doomed") && !jobs.contains("crasher"),
                "{jobs}"
            );
            let (ok, _, err) = run_cli(&["problems", "-n", ns, "--kind", "secrets"])?;
            assert!(!ok && err.contains("not secrets"), "{err}");
            return Ok(());
        }
        if std::time::Instant::now() > deadline {
            bail!("nauvi problems and the tool differ:\n{cli}\n---\n{tool}");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// The line of a `list` table whose first column is `name`.
fn row_of(text: &str, name: &str) -> String {
    text.lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
#[ignore]
async fn mcp_problems_on_the_cluster() -> Result<()> {
    let client = connect().await?;
    let ns = temp_ns(&client, "it-mcp-p").await?;
    let result = async {
        let mut w = Server::on_cluster(&["--allow-writes"]);
        w.ok(
            "apply",
            json!({ "manifest": PROBLEM_FIXTURES, "namespace": ns }),
        );
        drop(w);
        let mut s = Server::on_cluster(&[]);
        // Wait (bounded) for every state the asserts below read, in one
        // snapshot: crash loops and OOM kills take a few runs to show.
        let text = wait_for(&mut s, "problems", json!({ "namespace": ns }), |t| {
            let hog = problem_line(t, "hog");
            problem_line(t, "crasher").contains("last: Error (exit 3)")
                && hog.contains("OOMKilled (exit 137)")
                && hog.contains("limit memory 16Mi")
                && problem_line(t, "doomed").contains("Failed (BackoffLimitExceeded)")
                && problem_line(t, "never-ready").contains("0 of 1 ready")
        })?;
        assert!(text.starts_with("KIND"), "{text}");
        assert!(
            problem_line(&text, "crasher").contains("last: Error (exit 3)"),
            "{text}"
        );
        let hog = problem_line(&text, "hog");
        assert!(
            hog.contains("OOMKilled (exit 137)") && hog.contains("limit memory 16Mi"),
            "{text}"
        );
        assert!(
            problem_line(&text, "doomed").contains("Failed (BackoffLimitExceeded)"),
            "{text}"
        );
        assert!(!text.contains("healthy"), "{text}");
        assert!(text.contains("(checked pods, deployments"), "{text}");

        // `nauvi problems` (#466) prints the same findings as the tool: the
        // same objects with the same problems, read moments apart (a crash
        // loop's state can change between the two reads, so a few tries).
        cli_problems_match(&mut s, &ns)?;

        // Only the kinds asked for; Secrets are not one of them.
        let jobs = s.ok("problems", json!({ "namespace": ns, "kinds": ["job"] }));
        assert!(
            jobs.contains("doomed") && !jobs.contains("crasher"),
            "{jobs}"
        );
        let (err, msg) = s.call("problems", json!({ "namespace": ns, "kinds": ["secrets"] }));
        assert!(err && msg.contains("not secrets"), "{msg}");

        // list: LAST for pods; compact and columns.
        // `hog` keeps restarting; a later run may again report `Error`.
        let listed = wait_for(
            &mut s,
            "list",
            json!({ "kind": "pods", "namespace": ns, "compact": true }),
            |t| row_of(t, "hog").contains("OOMKilled"),
        )?;
        let header = listed.lines().next().unwrap_or_default();
        assert!(header.contains("LAST"), "{listed}");
        assert!(
            !header.contains("NODE") && !header.contains("NAMESPACE"),
            "{listed}"
        );
        assert!(row_of(&listed, "hog").contains("OOMKilled"), "{listed}");
        let narrow = s.ok(
            "list",
            json!({ "kind": "pods", "namespace": ns, "columns": ["name", "last"] }),
        );
        let header: Vec<_> = narrow.lines().next().unwrap().split_whitespace().collect();
        assert_eq!(header, ["NAME", "LAST"], "{narrow}");

        // An empty events list says events expire.
        let none = s.ok(
            "events",
            json!({ "namespace": ns, "kind": "pod", "name": "nope" }),
        );
        assert!(none.contains("about 1 hour"), "{none}");
        Ok(())
    }
    .await;
    drop_ns(&client, &ns).await;
    result
}
