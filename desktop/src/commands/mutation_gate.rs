//! Every command that changes a cluster goes through the read-only /
//! protected gate (#338, `state::mutation`).
//!
//! The test reads the commands from the bindings `specta_builder`
//! generates: a gated command's first parameter is `cluster:
//! MutationTarget`, any other cluster command's is `cluster: string`. A new
//! cluster command fails here until it is either gated or listed in
//! `READ_ONLY` with why it changes nothing.

/// The commands that change a cluster (or hand out a shell that can).
const GATED: &[&str] = &[
    "cmdApplyManifests",
    "cmdApplyResourceYaml",
    "cmdAttachStart",
    "cmdBulkDelete",
    "cmdDebugStart",
    "cmdDeleteResource",
    "cmdDrainNode",
    "cmdExecStart",
    "cmdHelmInstall",
    "cmdHelmRollback",
    "cmdHelmUninstall",
    "cmdHelmUpgrade",
    "cmdLocalShellStart",
    "cmdMetricsAddonInstall",
    "cmdNodeShellCleanup",
    "cmdNodeShellStart",
    "cmdPatchData",
    // Port-forwards: allowed on a read-only context, confirmed on a
    // protected one (`ForwardStart`).
    "cmdPortforwardStart",
    "cmdPortforwardStartSaved",
    "cmdRunAction",
];

/// The cluster commands that change nothing in the cluster, and why.
const READ_ONLY: &[(&str, &str)] = &[
    ("cmdApplicationsStart", "watches"),
    ("cmdApplicationsStop", "stops a watch"),
    ("cmdCancelDrain", "stops following a drain; changes nothing"),
    ("cmdCheckAccess", "access reviews"),
    ("cmdCheckActions", "access reviews"),
    ("cmdClusterConnect", "opens a session"),
    ("cmdClusterDisconnect", "closes a session"),
    ("cmdClusterReconnect", "restarts the session"),
    ("cmdDefaultNamespace", "reads"),
    ("cmdDetailWatch", "watches"),
    ("cmdDiscover", "reads"),
    ("cmdExecAck", "flow control of an allowed session"),
    ("cmdExecClose", "ends a session the gate allowed"),
    ("cmdExecInput", "a session the gate allowed"),
    ("cmdExecResize", "a session the gate allowed"),
    ("cmdGetDataEntries", "reads"),
    ("cmdGetMetrics", "reads"),
    ("cmdGetRelated", "reads"),
    ("cmdGetResourceDetail", "reads"),
    ("cmdGetResourceYaml", "reads"),
    ("cmdHelmCharts", "reads"),
    ("cmdHelmGet", "reads"),
    ("cmdHelmList", "reads"),
    (
        "cmdKubectlDownload",
        "downloads kubectl to the app's data dir; nothing in the cluster",
    ),
    ("cmdKubectlMatch", "reads the server version"),
    ("cmdListContexts", "reads the kubeconfig"),
    ("cmdListNamespaces", "reads"),
    ("cmdLocalShellAck", "flow control of an allowed shell"),
    ("cmdLocalShellClose", "ends a shell the gate allowed"),
    ("cmdLocalShellInput", "a shell the gate allowed"),
    ("cmdLocalShellResize", "a shell the gate allowed"),
    ("cmdLogAck", "flow control of a log stream"),
    ("cmdMetricsAddonAccess", "access reviews"),
    ("cmdNodeDiskUsage", "reads"),
    ("cmdNodeShellLeftovers", "reads"),
    ("cmdObjectLink", "builds a link"),
    ("cmdOverviewStart", "watches"),
    ("cmdOverviewStop", "stops a watch"),
    ("cmdOverviewUsage", "reads"),
    // Starts nothing on a protected context (the forwards come back
    // stopped); a read-only one allows forwards.
    (
        "cmdPortforwardAutostart",
        "port-forward, never on a protected context",
    ),
    ("cmdPortforwardDelete", "a saved forward in the settings"),
    ("cmdPortforwardElsewhere", "reads"),
    ("cmdPortforwardList", "reads"),
    ("cmdPortforwardSave", "a saved forward in the settings"),
    ("cmdPortforwardSaved", "reads"),
    ("cmdPortforwardStop", "stops a port-forward"),
    ("cmdPrometheusStatus", "reads"),
    ("cmdRevealDataValue", "reads"),
    ("cmdServicePorts", "reads"),
    ("cmdSetContext", "switches the window's session"),
    ("cmdStopLogs", "stops a stream"),
    ("cmdStreamPodAllLogs", "reads"),
    ("cmdStreamPodLogs", "reads"),
    ("cmdStreamWorkloadLogs", "reads"),
    ("cmdUsageHistory", "reads"),
    ("cmdWatchStart", "watches"),
    ("cmdWatchStop", "stops a watch"),
    ("cmdWorkloadUsageHistory", "reads"),
    ("cmdWorkloadsStart", "watches"),
    ("cmdWorkloadsStop", "stops a watch"),
];

/// `(command, type of its cluster parameter)` of each cluster command.
fn cluster_commands(bindings: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in bindings.lines() {
        // `\tcmdName: (cluster: string, ...) => __TAURI_INVOKE...`
        let Some(rest) = line.trim_start().strip_prefix("cmd") else {
            continue;
        };
        let Some((name, params)) = rest.split_once(": (") else {
            continue;
        };
        if let Some(p) = params.strip_prefix("cluster: ") {
            let ty: String = p.chars().take_while(|c| c.is_alphanumeric()).collect();
            out.push((format!("cmd{name}"), ty));
        }
    }
    out
}

#[test]
fn every_command_that_changes_a_cluster_is_gated() {
    let path = std::env::temp_dir().join(format!("nauvi-338-bindings-{}.ts", std::process::id()));
    super::specta_builder()
        .export(specta_typescript::Typescript::default(), &path)
        .expect("export the bindings");
    let bindings = std::fs::read_to_string(&path).unwrap();
    let _ = std::fs::remove_file(&path);
    let commands = cluster_commands(&bindings);
    assert!(commands.len() > 50, "found {} commands", commands.len());

    let mut unlisted = Vec::new();
    let mut ungated = Vec::new();
    let mut not_mutating = Vec::new();
    for (name, ty) in &commands {
        let gated = GATED.contains(&name.as_str());
        let read_only = READ_ONLY.iter().any(|(n, _)| n == name);
        assert!(!(gated && read_only), "{name} is in both lists");
        match ty.as_str() {
            "MutationTarget" if !gated => not_mutating.push(name.clone()),
            "MutationTarget" => {}
            _ if gated => ungated.push(name.clone()),
            _ if !read_only => unlisted.push(name.clone()),
            _ => {}
        }
    }
    assert!(
        unlisted.is_empty(),
        "new cluster commands: take `cluster: Mutation` if they change the cluster, \
         else list them in READ_ONLY: {unlisted:?}"
    );
    assert!(
        ungated.is_empty(),
        "these change the cluster but take `cluster: Cluster`: {ungated:?}"
    );
    assert!(
        not_mutating.is_empty(),
        "gated but not in GATED (add them): {not_mutating:?}"
    );
    // Nothing stale in the lists.
    for name in GATED.iter().chain(READ_ONLY.iter().map(|(n, _)| n)) {
        assert!(
            commands.iter().any(|(n, _)| n == name),
            "{name} is listed but is not a cluster command"
        );
    }
}
