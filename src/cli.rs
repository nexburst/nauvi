//! Table and text output for the `kubeloupe` CLI.

use crate::{
    exec_command, format_cpu, format_memory, get_namespaces, get_node_metrics, get_nodes,
    get_pod_logs, get_pod_metrics, get_pods, resources, stream_pod_logs, watch, ForwardStatus,
    ForwardTarget, LogOptions, NamespaceInfo, NodeInfo, NodeUsage, PodInfo, PodUsage, PortForward,
    PortSpec,
};
use anyhow::{Context, Result};
use kube::Client;

/// List pods, optionally scoped to one namespace (CLI output).
pub async fn list_pods(client: &Client, namespace: Option<&str>) -> Result<()> {
    let pods = get_pods(client, namespace).await?;
    print!("{}", pods_table(&pods));
    Ok(())
}

/// Build a table (header first) and size its columns to their content, as
/// `kubeloupe get` does.
fn table<T>(header: &[&str], items: &[T], cells: impl Fn(&T) -> Vec<String>) -> String {
    let mut rows = vec![header.iter().map(|h| h.to_string()).collect()];
    rows.extend(items.iter().map(cells));
    resources::align_columns(&rows)
}

fn pods_table(pods: &[PodInfo]) -> String {
    table(&["NAME", "NAMESPACE", "PHASE", "NODE", "AGE"], pods, |p| {
        vec![
            p.name.clone(),
            p.namespace.clone(),
            p.phase.clone(),
            p.node.clone(),
            p.age.clone(),
        ]
    })
}

fn namespaces_table(namespaces: &[NamespaceInfo]) -> String {
    table(&["NAME", "STATUS", "AGE"], namespaces, |n| {
        vec![n.name.clone(), n.status.clone(), n.age.clone()]
    })
}

fn nodes_table(nodes: &[NodeInfo]) -> String {
    table(&["NAME", "READY", "VERSION", "AGE"], nodes, |n| {
        vec![
            n.name.clone(),
            n.ready.clone(),
            n.version.clone(),
            n.age.clone(),
        ]
    })
}

pub(crate) fn top_pods_table(usages: &[PodUsage]) -> String {
    table(&["NAME", "NAMESPACE", "CPU", "MEMORY"], usages, |u| {
        vec![
            u.name.clone(),
            u.namespace.clone(),
            format_cpu(u.cpu_millicores),
            format_memory(u.memory_bytes),
        ]
    })
}

/// Usage, and `usage/capacity` when the capacity is known.
fn of_capacity(used: u64, capacity: u64, format: fn(u64) -> String) -> String {
    if capacity > 0 {
        format!("{}/{}", format(used), format(capacity))
    } else {
        format(used)
    }
}

pub(crate) fn top_nodes_table(usages: &[NodeUsage]) -> String {
    table(&["NAME", "CPU", "MEMORY"], usages, |u| {
        vec![
            u.name.clone(),
            of_capacity(u.cpu_millicores, u.cpu_capacity_millicores, format_cpu),
            of_capacity(u.memory_bytes, u.memory_capacity_bytes, format_memory),
        ]
    })
}

/// List all namespaces in the cluster (CLI output).
pub async fn list_namespaces(client: &Client) -> Result<()> {
    let namespaces = get_namespaces(client).await?;
    print!("{}", namespaces_table(&namespaces));
    Ok(())
}

/// List all nodes in the cluster (CLI output).
pub async fn list_nodes(client: &Client) -> Result<()> {
    let nodes = get_nodes(client).await?;
    print!("{}", nodes_table(&nodes));
    Ok(())
}

/// Print a pod's logs (CLI output). With `follow`, keeps streaming until
/// interrupted.
pub async fn print_pod_logs(
    client: &Client,
    namespace: Option<&str>,
    name: &str,
    opts: &LogOptions,
    follow: bool,
) -> Result<()> {
    let namespace = namespace.unwrap_or("default");
    if follow {
        anyhow::ensure!(
            !opts.previous,
            "--follow cannot be combined with --previous"
        );
        stream_pod_logs(client, namespace, name, opts, |line| println!("{line}")).await
    } else {
        let logs = get_pod_logs(client, namespace, name, opts).await?;
        print!("{logs}");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// CLI output for the new commands.
// ---------------------------------------------------------------------------

/// Print `kubectl top pods`-style usage (CLI output), optionally for one
/// namespace. The namespace is queried directly (not filtered from a
/// cluster-wide list), so it works for users limited to that namespace.
pub async fn print_top_pods(client: &Client, namespace: Option<&str>) -> Result<()> {
    match get_pod_metrics(client, namespace).await? {
        None => {
            anyhow::bail!(
                "Metrics API not available on this cluster (is metrics-server installed?)"
            )
        }
        Some(usages) => print!("{}", top_pods_table(&usages)),
    }
    Ok(())
}

/// Print `kubectl top nodes`-style usage (CLI output).
pub async fn print_top_nodes(client: &Client) -> Result<()> {
    match get_node_metrics(client).await? {
        None => {
            anyhow::bail!(
                "Metrics API not available on this cluster (is metrics-server installed?)"
            )
        }
        Some(usages) => print!("{}", top_nodes_table(&usages)),
    }
    Ok(())
}

/// Forward ports of a pod, Service or workload to localhost until Ctrl-C
/// (CLI output). Prints which pod serves each forward when it changes, and
/// errors as they happen.
pub async fn run_port_forward(
    client: &Client,
    namespace: Option<&str>,
    target: &str,
    ports: &[String],
) -> Result<()> {
    let ns = namespace.unwrap_or(client.default_namespace());
    let target = ForwardTarget::parse(target, ns)?;
    let specs = ports
        .iter()
        .map(|p| PortSpec::parse(p))
        .collect::<Result<Vec<_>>>()?;
    let mut forwards = Vec::new();
    for spec in specs {
        let f = PortForward::start(client, target.clone(), spec.remote, spec.local).await?;
        println!(
            "Forwarding from 127.0.0.1:{} -> {}:{}",
            f.local_port,
            target_label(&target),
            f.remote
        );
        forwards.push(f);
    }
    println!("Ctrl-C to stop.");
    let mut last: Vec<ForwardStatus> = forwards.iter().map(|f| f.status()).collect();
    for (f, s) in forwards.iter().zip(&last) {
        println!("  127.0.0.1:{} served by pod {}", f.local_port, s.pod);
    }
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {
            r = tokio::signal::ctrl_c() => { r?; break; }
            _ = tick.tick() => {
                for (f, prev) in forwards.iter().zip(last.iter_mut()) {
                    let now = f.status();
                    if now.pod != prev.pod {
                        println!("  127.0.0.1:{} now served by pod {}", f.local_port, now.pod);
                    }
                    if now.last_error != prev.last_error && !now.last_error.is_empty() {
                        eprintln!("  127.0.0.1:{}: {}", f.local_port, now.last_error);
                    }
                    *prev = now;
                }
            }
        }
    }
    drop(forwards);
    println!("Port-forward stopped.");
    Ok(())
}

/// `svc/api` (the namespace is implied by `-n`).
fn target_label(t: &ForwardTarget) -> String {
    format!("{}/{}", t.kind.short(), t.name)
}

/// A remote command that ran and exited non-zero: the CLI exits with its
/// code, like `kubectl exec`.
#[derive(Debug)]
pub struct RemoteExit(pub i32);

impl std::fmt::Display for RemoteExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "command terminated with exit code {}", self.0)
    }
}

impl std::error::Error for RemoteExit {}

/// Run a command in a pod and print its output (CLI output). A command that
/// exits non-zero becomes a [`RemoteExit`] error with its exit code.
pub async fn exec_in_pod(
    client: &Client,
    namespace: Option<&str>,
    name: &str,
    container: Option<&str>,
    command: &[String],
) -> Result<()> {
    let result = exec_command(
        client,
        namespace.unwrap_or("default"),
        name,
        container,
        command,
    )
    .await?;
    print!("{}", result.stdout);
    // stdout is line-buffered: without this, output that doesn't end with a
    // newline would only appear at exit, after our `error:` line on stderr.
    std::io::Write::flush(&mut std::io::stdout())?;
    eprint!("{}", result.stderr);
    if result.success {
        return Ok(());
    }
    // Our `error:` line starts a line of its own, also when the output did
    // not end one (on a terminal both streams share the screen).
    let stdout_open =
        std::io::IsTerminal::is_terminal(&std::io::stdout()) && !ends_line(&result.stdout);
    if !ends_line(&result.stderr) || stdout_open {
        eprintln!();
    }
    if !result.error.is_empty() {
        anyhow::bail!("{}", result.error);
    }
    Err(RemoteExit(result.exit_code).into())
}

/// Whether printing `s` leaves the cursor at the start of a line.
fn ends_line(s: &str) -> bool {
    s.is_empty() || s.ends_with('\n')
}

/// Print live changes to any resource type until interrupted.
pub async fn watch_and_print(
    client: &Client,
    resource: &str,
    namespace: Option<&str>,
) -> Result<()> {
    use watch::{run_batched, Output, DEFAULT_FLUSH};
    fn print<T: std::fmt::Debug>(out: Output<T>) {
        match out {
            Output::State(s) => println!("state: {s:?}"),
            Output::Batch(b) => {
                println!(
                    "{}: {} applied, {} deleted",
                    if b.snapshot { "snapshot" } else { "batch" },
                    b.applied.len(),
                    b.deleted.len()
                );
                for item in &b.applied {
                    println!("  + {item:?}");
                }
                for key in &b.deleted {
                    println!("  - {key}");
                }
            }
        }
    }
    let kinds = resources::discover(client).await?;
    let kind = resources::resolve_kind(&kinds, resource)
        .with_context(|| format!("unknown resource type: {resource}"))?;
    let prober = crate::liveness::Prober::new(client.clone());
    let (_store, updates) = watch::watch_resource(client, &prober, kind, namespace);
    run_batched(updates, DEFAULT_FLUSH, print).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Check that every row's cells start in the column of their header word,
    /// and that no line has trailing whitespace.
    fn assert_aligned(out: &str, header: &[&str], rows: &[&[&str]]) {
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), rows.len() + 1, "{out}");
        let cols: Vec<usize> = header.iter().map(|w| lines[0].find(w).unwrap()).collect();
        for (line, cells) in lines[1..].iter().zip(rows) {
            for (col, cell) in cols.iter().zip(cells.iter()) {
                assert_eq!(&line[*col..*col + cell.len()], *cell, "{out}");
            }
        }
        assert!(out.lines().all(|l| l == l.trim_end()), "{out}");
    }

    #[test]
    fn pods_table_lines_up_long_names() {
        let pod = |name: &str, node: &str| PodInfo {
            created: 0,
            name: name.into(),
            namespace: "kube-system".into(),
            phase: "Running".into(),
            node: node.into(),
            age: "2d".into(),
        };
        let long = "kube-controller-manager-kubeloupe-test-control-plane-with-more";
        let node = "ip-10-0-1-23.eu-west-1.compute.internal";
        let out = pods_table(&[pod("hungry", ""), pod(long, node)]);
        assert_aligned(
            &out,
            &["NAME", "NAMESPACE", "PHASE", "NODE", "AGE"],
            &[
                &["hungry", "kube-system", "Running", "", "2d"],
                &[long, "kube-system", "Running", node, "2d"],
            ],
        );
    }

    #[test]
    fn namespaces_and_nodes_tables_line_up() {
        let ns = NamespaceInfo {
            created: 0,
            name: "a-namespace-name-longer-than-thirty-characters".into(),
            status: "Terminating".into(),
            age: "1d".into(),
        };
        assert_aligned(
            &namespaces_table(std::slice::from_ref(&ns)),
            &["NAME", "STATUS", "AGE"],
            &[&[&ns.name, "Terminating", "1d"]],
        );
        let node = NodeInfo {
            created: 0,
            name: "gke-cluster-1-default-pool-0123abcd-wxyz-and-some-more".into(),
            ready: "True".into(),
            version: "v1.31.0-gke.1234567".into(),
            age: "9d".into(),
        };
        assert_aligned(
            &nodes_table(std::slice::from_ref(&node)),
            &["NAME", "READY", "VERSION", "AGE"],
            &[&[&node.name, "True", "v1.31.0-gke.1234567", "9d"]],
        );
    }

    #[test]
    fn top_tables_line_up() {
        let pod = PodUsage {
            namespace: "a-long-namespace-name-here".into(),
            name: "a-pod-name-that-is-much-longer-than-fifty-characters-x".into(),
            cpu_millicores: 1500,
            memory_bytes: 64 * 1024 * 1024,
            containers: vec![],
        };
        let (cpu, mem) = (format_cpu(1500), format_memory(64 * 1024 * 1024));
        assert_aligned(
            &top_pods_table(std::slice::from_ref(&pod)),
            &["NAME", "NAMESPACE", "CPU", "MEMORY"],
            &[&[&pod.name, &pod.namespace, &cpu, &mem]],
        );
        let node = NodeUsage {
            name: "ip-10-0-1-23.eu-west-1.compute.internal".into(),
            cpu_millicores: 250,
            cpu_capacity_millicores: 4000,
            memory_bytes: 1024 * 1024 * 1024,
            memory_capacity_bytes: 0,
        };
        let cpu = format!("{}/{}", format_cpu(250), format_cpu(4000));
        let mem = format_memory(1024 * 1024 * 1024);
        assert_aligned(
            &top_nodes_table(std::slice::from_ref(&node)),
            &["NAME", "CPU", "MEMORY"],
            &[&[&node.name, &cpu, &mem]],
        );
    }
}
