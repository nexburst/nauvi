//! The Tauri commands, one module per concern, and `specta_builder`, which
//! registers them and their events.
//!
//! The lists below are sorted (modules, then commands and events) with one
//! entry per line and a trailing comma, so branches that add commands to
//! different modules do not touch the same lines. Keep them that way: add a
//! new entry at its sorted place, never at the end.

pub(crate) mod actions;
pub(crate) mod applications;
pub(crate) mod catalog;
pub(crate) mod cluster;
pub(crate) mod debug;
pub(crate) mod exec;
pub(crate) mod files;
pub(crate) mod helm;
pub(crate) mod helm_charts;
pub(crate) mod help;
pub(crate) mod local_shell;
pub(crate) mod logs;
pub(crate) mod overview;
pub(crate) mod portforward;
pub(crate) mod prometheus;
pub(crate) mod resources;
pub(crate) mod settings;
pub(crate) mod updater;
pub(crate) mod usage;
pub(crate) mod watch;
pub(crate) mod window;
pub(crate) mod workload_usage;
pub(crate) mod workloads;

use tauri_specta::{collect_commands, collect_events, Builder};

/// The typed command and event registry. Also used to generate
/// `ui-src/src/lib/bindings.ts`, where the commands keep this order.
pub(crate) fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            actions::cmd_bulk_delete,
            actions::cmd_cancel_drain,
            actions::cmd_check_actions,
            actions::cmd_drain_node,
            actions::cmd_run_action,
            applications::cmd_applications_start,
            applications::cmd_applications_stop,
            catalog::cmd_add_kubeconfig_source,
            catalog::cmd_answer_exec_command,
            catalog::cmd_check_context,
            catalog::cmd_exec_commands,
            catalog::cmd_kubeconfig_sources,
            catalog::cmd_paste_kubeconfig,
            catalog::cmd_remove_kubeconfig_source,
            cluster::cmd_check_access,
            cluster::cmd_default_namespace,
            cluster::cmd_discover,
            cluster::cmd_get_metrics,
            cluster::cmd_list_contexts,
            cluster::cmd_list_namespaces,
            cluster::cmd_set_context,
            debug::cmd_debug_start,
            debug::cmd_node_shell_cleanup,
            debug::cmd_node_shell_leftovers,
            debug::cmd_node_shell_start,
            exec::cmd_attach_start,
            exec::cmd_exec_close,
            exec::cmd_exec_input,
            exec::cmd_exec_resize,
            exec::cmd_exec_start,
            files::cmd_save_csv,
            helm::cmd_helm_charts,
            helm::cmd_helm_get,
            helm::cmd_helm_list,
            helm::cmd_helm_rollback,
            helm::cmd_helm_uninstall,
            helm::cmd_helm_version,
            helm_charts::cmd_helm_chart_show,
            helm_charts::cmd_helm_chart_versions,
            helm_charts::cmd_helm_install,
            helm_charts::cmd_helm_repo_add,
            helm_charts::cmd_helm_repo_list,
            helm_charts::cmd_helm_repo_remove,
            helm_charts::cmd_helm_repo_update,
            helm_charts::cmd_helm_search,
            helm_charts::cmd_helm_upgrade,
            help::cmd_diagnostics,
            help::cmd_help_open,
            help::cmd_log_ui_error,
            local_shell::cmd_local_shell_close,
            local_shell::cmd_local_shell_input,
            local_shell::cmd_local_shell_resize,
            local_shell::cmd_local_shell_start,
            logs::cmd_save_logs,
            logs::cmd_stop_logs,
            logs::cmd_stream_pod_all_logs,
            logs::cmd_stream_pod_logs,
            logs::cmd_stream_workload_logs,
            overview::cmd_overview_start,
            overview::cmd_overview_stop,
            portforward::cmd_portforward_autostart,
            portforward::cmd_portforward_delete,
            portforward::cmd_portforward_list,
            portforward::cmd_portforward_save,
            portforward::cmd_portforward_saved,
            portforward::cmd_portforward_start,
            portforward::cmd_portforward_start_saved,
            portforward::cmd_portforward_stop,
            portforward::cmd_service_ports,
            prometheus::cmd_prometheus_status,
            resources::cmd_apply_manifests,
            resources::cmd_apply_resource_yaml,
            resources::cmd_delete_resource,
            resources::cmd_get_data_entries,
            resources::cmd_get_related,
            resources::cmd_get_resource_detail,
            resources::cmd_get_resource_yaml,
            resources::cmd_patch_data,
            resources::cmd_reveal_data_value,
            settings::cmd_get_settings,
            settings::cmd_update_settings,
            updater::cmd_update_check,
            updater::cmd_update_install,
            usage::cmd_usage_history,
            watch::cmd_detail_watch,
            watch::cmd_watch_start,
            watch::cmd_watch_stop,
            window::cmd_discard_and_close,
            window::cmd_open_window,
            window::cmd_set_unsaved,
            window::cmd_set_zoom,
            workload_usage::cmd_workload_usage_history,
            workloads::cmd_workloads_start,
            workloads::cmd_workloads_stop,
        ])
        .events(collect_events![
            actions::DrainFinished,
            actions::DrainProgress,
            applications::ApplicationsChanged,
            applications::ApplicationsStateChanged,
            crate::catalog::KubeconfigsChanged,
            exec::ExecClosed,
            exec::ExecOutput,
            logs::PodLog,
            logs::PodLogDone,
            logs::PodLogError,
            logs::WorkloadLog,
            logs::WorkloadNotice,
            overview::OverviewChanged,
            overview::OverviewStateChanged,
            updater::UpdateProgress,
            watch::DetailWatchEvent,
            watch::WatchBatch,
            watch::WatchStateChanged,
            window::UnsavedCloseRequested,
            workloads::WorkloadsChanged,
            workloads::WorkloadsStateChanged,
        ])
        // Counters and epoch seconds stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}
