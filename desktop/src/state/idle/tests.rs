//! The idle reaper with a fake clock (ADR 0007).

use super::*;
use crate::state::{ForwardSession, MAIN_WINDOW};
use kube::Client;
use std::sync::atomic::AtomicU64;

const MIN: u64 = 60_000;

/// An app state whose clock the test moves, starting at minute 0.
fn state() -> (AppState, Arc<AtomicU64>) {
    let now = Arc::new(AtomicU64::new(1));
    let clock = now.clone();
    (
        AppState::with_clock(move || clock.load(Ordering::SeqCst)),
        now,
    )
}

fn at(now: &AtomicU64, minutes: u64) {
    now.store(minutes * MIN + 1, Ordering::SeqCst);
}

fn no_plugin(_: &str) -> bool {
    false
}

/// One reaper pass that disconnects after `minutes`.
fn reap(state: &AppState, minutes: u64) -> Vec<(String, ClusterStateChanged)> {
    state.reap(&Reap {
        now: state.clock.now(),
        idle_after: Some(Duration::from_secs(minutes * 60)),
        plugin_login: &no_plugin,
    })
}

/// Give `session` a client, as its first command would (nothing is sent).
fn fake_connect(session: &ClusterSession) {
    let client = tauri::async_runtime::block_on(async {
        Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap())).unwrap()
    });
    let prober = nauvi::liveness::Prober::new(client.clone());
    *session.client.try_lock().unwrap() = Some((client, prober));
    session.idle.connected();
}

fn changed(
    cluster: &str,
    state: ClusterState,
    pinned_by: Vec<Pin>,
) -> (String, ClusterStateChanged) {
    (
        MAIN_WINDOW.to_string(),
        ClusterStateChanged {
            cluster: cluster.into(),
            state,
            pinned_by,
        },
    )
}

fn forever() -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(std::future::pending())
}

fn forward() -> ForwardSession {
    let target = nauvi::ForwardTarget::parse("svc/web", "demo").unwrap();
    let remote = nauvi::RemotePort::parse("80").unwrap();
    let forward =
        tauri::async_runtime::block_on(async { nauvi::PortForward::idle(target, remote, 8080) });
    ForwardSession {
        forward,
        started_at: 0,
        saved_id: "fwd".into(),
        https: false,
    }
}

#[test]
fn an_untouched_background_cluster_is_disconnected_after_the_timeout() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    let b = state.connect(MAIN_WINDOW, Some("b".into()));
    fake_connect(&b);
    let resource = nauvi::resources::ResourceRef {
        group: "".into(),
        version: "v1".into(),
        kind: "Pod".into(),
        plural: "pods".into(),
        namespaced: true,
    };
    b.kinds
        .lock()
        .unwrap()
        .push(nauvi::resources::ResourceKind {
            id: resource.id(),
            label: "Pods".into(),
            category: nauvi::resources::Category::Other,
            crd: false,
            verbs: vec![],
            short_names: vec![],
            columns: vec![],
            actions: vec![],
            resource,
        });
    *b.image_security.lock().unwrap() = Some(crate::commands::image_security::VulnsCache::empty());
    assert_eq!(state.live_sessions(), 1);

    at(&now, 9);
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Connected, vec![])]
    );
    assert_eq!(state.live_sessions(), 1);
    // Nothing changed: nothing to report.
    assert!(reap(&state, 10).is_empty());

    at(&now, 10);
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Idle, vec![])]
    );
    assert_eq!(state.live_sessions(), 0);
    assert!(b.kinds.lock().unwrap().is_empty());
    assert!(b.usage.lock().unwrap().is_empty());
    assert!(b.prometheus.lock().unwrap().is_none());
    assert!(b.image_security.lock().unwrap().is_none());
    assert!(b.image_config.lock().unwrap().is_none());
    // Still connected to the window: the next command connects again.
    assert!(!b.is_closed());
    assert!(Arc::ptr_eq(&b, &state.cluster(MAIN_WINDOW, "b")));
    assert!(reap(&state, 10).is_empty());

    fake_connect(&b);
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Connected, vec![])]
    );
}

#[test]
fn the_visible_cluster_is_never_disconnected() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    fake_connect(&state.session(MAIN_WINDOW));
    at(&now, 60);
    assert!(reap(&state, 10).is_empty());
    assert_eq!(state.live_sessions(), 1);
}

#[test]
fn a_command_touches_its_cluster() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    let b = state.connect(MAIN_WINDOW, Some("b".into()));
    fake_connect(&b);
    at(&now, 8);
    // What the `Cluster` argument of every command does.
    state.cluster(MAIN_WINDOW, "b");
    at(&now, 12);
    reap(&state, 10);
    assert_eq!(state.live_sessions(), 1);
    at(&now, 18);
    reap(&state, 10);
    assert_eq!(state.live_sessions(), 0);
}

#[test]
fn zero_minutes_is_never() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    fake_connect(&state.connect(MAIN_WINDOW, Some("b".into())));
    at(&now, 24 * 60);
    let pass = Reap {
        now: state.clock.now(),
        idle_after: None,
        plugin_login: &no_plugin,
    };
    state.reap(&pass);
    assert_eq!(state.live_sessions(), 1);
}

#[test]
fn what_runs_in_a_cluster_keeps_it_connected() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    let b = state.connect(MAIN_WINDOW, Some("b".into()));
    fake_connect(&b);
    assert!(b.add_forward("pf-1".into(), forward()));
    b.log_streams.start(1, forever).unwrap();
    b.add_drain("d1".into(), forever());
    at(&now, 30);
    assert_eq!(
        reap(&state, 10),
        vec![changed(
            "b",
            ClusterState::Connected,
            vec![Pin::PortForward, Pin::LogStream, Pin::Drain]
        )]
    );
    assert_eq!(state.live_sessions(), 1);

    b.forwards.lock().unwrap().clear();
    b.log_streams.stop(1);
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Connected, vec![Pin::Drain])]
    );
    b.drains.lock().unwrap().clear();
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Idle, vec![])]
    );
    assert_eq!(state.live_sessions(), 0);
}

#[test]
fn a_plugin_login_is_never_disconnected() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    fake_connect(&state.connect(MAIN_WINDOW, Some("sso".into())));
    at(&now, 60);
    let pass = Reap {
        now: state.clock.now(),
        idle_after: Some(Duration::from_secs(60)),
        plugin_login: &|id: &str| id == "sso",
    };
    assert_eq!(
        state.reap(&pass),
        vec![changed(
            "sso",
            ClusterState::Connected,
            vec![Pin::PluginLogin]
        )]
    );
    assert_eq!(state.live_sessions(), 1);
}

#[test]
fn a_cluster_never_connected_is_not_reported() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    state.connect(MAIN_WINDOW, Some("b".into()));
    at(&now, 60);
    assert!(reap(&state, 10).is_empty());
}

/// A drain task that panics once `go` is sent; its handle stays in the map.
fn panicking_drain() -> (
    tauri::async_runtime::JoinHandle<()>,
    tokio::sync::oneshot::Sender<()>,
) {
    let (go, wait) = tokio::sync::oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        let _ = wait.await;
        panic!("drain failed");
    });
    (task, go)
}

fn wait_finished(task: &tauri::async_runtime::JoinHandle<()>) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !task.inner().is_finished() {
        assert!(std::time::Instant::now() < deadline, "the task did not end");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_left_session_whose_drain_panicked_is_forgotten() {
    let (state, _now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    let a = state.session(MAIN_WINDOW);
    let (task, go) = panicking_drain();
    a.add_drain("d1".into(), task);
    // Starting the cluster over leaves the session, kept for its drain.
    state.reconnect(MAIN_WINDOW, "a");
    assert_eq!(state.all_sessions("").len(), 2);
    assert!(a.has_live_drain());
    go.send(()).unwrap();
    wait_finished(a.drains.lock().unwrap().get("d1").unwrap());
    // Its handle is still there (no `drain_ended`), but it counts for nothing.
    assert_eq!(a.drains.lock().unwrap().len(), 1);
    reap(&state, 10);
    assert_eq!(state.all_sessions("").len(), 1);
    drop(state);
    assert_eq!(Arc::strong_count(&a), 1, "nothing holds the left session");
}

#[test]
fn a_drain_that_ended_before_it_was_added_pins_nothing() {
    let (state, now) = state();
    state.open(MAIN_WINDOW, Some("a".into()));
    let b = state.connect(MAIN_WINDOW, Some("b".into()));
    fake_connect(&b);
    // It failed at once, before the command registered it.
    let task = tauri::async_runtime::spawn(async {});
    wait_finished(&task);
    b.add_drain("d1".into(), task);
    at(&now, 30);
    assert_eq!(
        reap(&state, 10),
        vec![changed("b", ClusterState::Idle, vec![])]
    );
    assert_eq!(state.live_sessions(), 0);

    // The same in a left session: starting over does not keep it.
    let a = state.session(MAIN_WINDOW);
    let task = tauri::async_runtime::spawn(async {});
    wait_finished(&task);
    a.add_drain("d2".into(), task);
    state.reconnect(MAIN_WINDOW, "a");
    assert_eq!(state.all_sessions("").len(), 2, "b, and the new a");
    assert!(state.all_sessions("").iter().all(|s| !Arc::ptr_eq(s, &a)));
}

/// An added kubeconfig whose login command prints a token and counts its
/// runs in `ran`.
#[cfg(unix)]
fn added_with_plugin(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let file = dir.join("sso.yaml");
    let ran = dir.join("ran");
    std::fs::write(
        &file,
        format!(
            r#"apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {{server: "https://127.0.0.1:1"}}
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: /bin/sh
      args: [-c, 'echo x >> {ran}; echo "{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"t\"}}}}"']
      interactiveMode: Never
contexts:
- name: {id}
  context: {{cluster: c, user: u}}
"#,
            ran = ran.display()
        ),
    )
    .unwrap();
    file
}

/// A reconnect after an idle disconnect uses the answer the user gave about
/// the login command (#201): nothing asks again.
#[cfg(unix)]
#[test]
fn reconnecting_reuses_the_stored_login_answer() {
    let id = "nauvi-333-idle-consent";
    let dir = std::env::temp_dir().join(format!("{id}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let file = added_with_plugin(&dir, id);
    let source = file.display().to_string();
    let sources = Arc::new(crate::catalog::KubeconfigSources::default());
    sources.set_extra(std::slice::from_ref(&source));
    let command = sources.exec_commands(&source)[0].command.clone();
    sources.answer_exec(&source, &command, true).unwrap();

    let session = ClusterSession::new(id.into(), Some(id.into()), sources.clone());
    fake_connect(&session);
    assert!(session.disconnect_idle());
    assert!(session.idle.idle.load(Ordering::SeqCst));
    // Connecting again runs the login command without asking: it fails
    // only because nothing listens at the server.
    let err = tauri::async_runtime::block_on(session.client())
        .err()
        .unwrap();
    assert!(err.starts_with("Cannot reach the cluster"), "{err}");
    assert_eq!(std::fs::read_to_string(dir.join("ran")).unwrap(), "x\n");
    assert_eq!(
        sources.exec_commands(&source)[0].answer,
        crate::catalog::ExecAnswer::Allowed
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Against the kind cluster: a background cluster that did real requests
/// has no client left once the timeout passed, and the next request
/// connects it again.
#[test]
#[ignore]
fn cluster_idle_sessions_go_to_zero() {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".into());
    let (state, now) = state();
    // The window shows a cluster that never connects.
    state.open(MAIN_WINDOW, Some("nauvi-333-not-a-context".into()));
    let session = state.connect(MAIN_WINDOW, Some(ctx.clone()));
    let list = |s: &ClusterSession| {
        tauri::async_runtime::block_on(async {
            let client = s.client().await.unwrap();
            nauvi::list_namespaces_if_allowed(&client).await.unwrap()
        })
    };
    assert!(list(&session).is_some_and(|ns| !ns.is_empty()));
    assert_eq!(state.live_sessions(), 1);

    at(&now, 9);
    reap(&state, 10);
    assert_eq!(state.live_sessions(), 1);
    at(&now, 11);
    let told = reap(&state, 10);
    assert_eq!(told, vec![changed(&ctx, ClusterState::Idle, vec![])]);
    assert_eq!(state.live_sessions(), 0);

    // The next command connects again.
    let again = state.cluster(MAIN_WINDOW, &ctx);
    assert!(list(&again).is_some());
    assert_eq!(state.live_sessions(), 1);
    assert_eq!(
        reap(&state, 10),
        vec![changed(&ctx, ClusterState::Connected, vec![])]
    );
}
