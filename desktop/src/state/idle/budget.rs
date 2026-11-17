//! The backend memory budget per idle connected cluster (ADR 0007), against
//! the kind cluster: a window connects 1 cluster, then 6 (contexts of one
//! kubeconfig that all point at kind, `scripts/test-cluster/multi-kubeconfig.sh`),
//! each discovered as expanding its node does. What each of the 5 more
//! costs, (RSS6 - RSS1) / 5, must stay within [`BUDGET_KB`]. RSS is noisy,
//! so each run is a fresh process (the test binary again, running
//! [`rss_probe`]) and the budget takes the median of [`RUNS`] runs. After
//! the idle timeout (a short one here) no session may keep its client.
//!
//! The numbers go to stdout and, on GitHub Actions, to the job summary.

use super::*;
use crate::state::MAIN_WINDOW;
use std::path::PathBuf;
use std::process::Command;

/// At most this much backend RSS per idle connected cluster (ADR 0007).
const BUDGET_KB: i64 = 5 * 1024;
const CLUSTERS: usize = 6;
const RUNS: usize = 3;
/// Set in the probe's process: where the kubeconfig is.
const PROBE: &str = "NAUVI_BUDGET_PROBE";

fn rss_kb() -> i64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
        .expect("VmRSS in /proc/self/status")
}

/// Connect `id` in the window's background and discover its kinds, as
/// expanding its node in the tree does (`cmd_discover`).
fn connect_and_discover(state: &AppState, id: &str) {
    let session = state.connect(MAIN_WINDOW, Some(id.into()));
    tauri::async_runtime::block_on(async {
        let client = session.client().await.unwrap();
        let kinds = nauvi::resources::discover(&client).await.unwrap();
        assert!(!kinds.is_empty(), "{id} served no kinds");
        *session.kinds.lock().unwrap() = kinds;
    });
}

/// One run, in a process of its own (only with [`PROBE`] set): prints
/// `budget-probe rss1=<kB> rss6=<kB> idle=<kB> live=<sessions>`.
#[test]
#[ignore]
fn rss_probe() {
    if std::env::var_os(PROBE).is_none() {
        return;
    }
    let settle = || std::thread::sleep(Duration::from_secs(2));
    let state = AppState::default();
    // The window shows a cluster that never connects: all 6 are background
    // ones, which the reaper may disconnect.
    state.open(MAIN_WINDOW, Some("budget-not-a-context".into()));
    connect_and_discover(&state, "budget-1");
    settle();
    let rss1 = rss_kb();
    for i in 2..=CLUSTERS {
        connect_and_discover(&state, &format!("budget-{i}"));
    }
    settle();
    let rss6 = rss_kb();
    assert_eq!(state.live_sessions(), CLUSTERS);

    // The idle timeout, short: untouched for 1 s.
    std::thread::sleep(Duration::from_millis(1500));
    let told = state.reap(&Reap {
        now: state.clock.now(),
        idle_after: Some(Duration::from_secs(1)),
        plugin_login: &|_| false,
    });
    assert_eq!(
        told.iter()
            .filter(|(_, c)| c.state == ClusterState::Idle)
            .count(),
        CLUSTERS,
        "{told:?}"
    );
    settle();
    println!(
        "budget-probe rss1={rss1} rss6={rss6} idle={} live={}",
        rss_kb(),
        state.live_sessions()
    );
}

struct Run {
    rss1: i64,
    rss6: i64,
    idle: i64,
    live: usize,
}

impl Run {
    fn per_cluster(&self) -> i64 {
        (self.rss6 - self.rss1) / (CLUSTERS as i64 - 1)
    }
}

fn probe(kubeconfig: &std::path::Path) -> Run {
    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "state::idle::budget::rss_probe",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(PROBE, "1")
        .env("KUBECONFIG", kubeconfig)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "the probe failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let line = stdout
        .lines()
        // The harness prints the test's name on the same line.
        .find_map(|l| l.find("budget-probe ").map(|i| &l[i..]))
        .unwrap_or_else(|| panic!("no budget-probe line in:\n{stdout}"));
    let field = |name: &str| -> i64 {
        line.split_whitespace()
            .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| panic!("{name} in {line}"))
    };
    Run {
        rss1: field("rss1"),
        rss6: field("rss6"),
        idle: field("idle"),
        live: field("live") as usize,
    }
}

/// Write a kubeconfig with [`CLUSTERS`] contexts pointing at the test
/// cluster.
fn budget_kubeconfig(dir: &std::path::Path) -> PathBuf {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/test-cluster/multi-kubeconfig.sh");
    let path = dir.join("kubeconfig");
    let status = Command::new("bash")
        .arg(script)
        .arg(&path)
        .arg(CLUSTERS.to_string())
        .status()
        .unwrap();
    assert!(status.success(), "multi-kubeconfig.sh failed");
    path
}

#[test]
#[ignore]
fn cluster_budget_per_idle_cluster() {
    let dir = std::env::temp_dir().join(format!("nauvi-budget-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let kubeconfig = budget_kubeconfig(&dir);
    let mut runs: Vec<Run> = (0..RUNS).map(|_| probe(&kubeconfig)).collect();
    let _ = std::fs::remove_dir_all(&dir);
    runs.sort_by_key(Run::per_cluster);
    let median = runs[RUNS / 2].per_cluster();

    let mb = |kb: i64| format!("{:.1} MB", kb as f64 / 1024.0);
    let mut md = format!(
        "### Backend memory per idle cluster (ADR 0007)\n\n\
         {CLUSTERS} contexts pointing at kind, each discovered; RSS of the test process.\n\n\
         | Run | RSS, 1 cluster | RSS, {CLUSTERS} clusters | Per extra cluster | RSS after idle disconnect | Live sessions after |\n\
         | ---: | ---: | ---: | ---: | ---: | ---: |\n"
    );
    for (i, r) in runs.iter().enumerate() {
        md += &format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            i + 1,
            mb(r.rss1),
            mb(r.rss6),
            mb(r.per_cluster()),
            mb(r.idle),
            r.live
        );
    }
    md += &format!(
        "\nMedian per extra cluster: **{}** (budget {}).\n\n",
        mb(median),
        mb(BUDGET_KB)
    );
    println!("{md}");
    if let Some(summary) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(summary)
            .unwrap();
        let _ = f.write_all(md.as_bytes());
    }

    for r in &runs {
        assert_eq!(r.live, 0, "sessions still connected after the idle timeout");
    }
    assert!(
        median <= BUDGET_KB,
        "{} per idle connected cluster, over the budget of {}",
        mb(median),
        mb(BUDGET_KB)
    );
}
