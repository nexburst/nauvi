//! The Tauri commands, one module per concern, and `specta_builder`, which
//! registers them and their events.
//!
//! The lists below are sorted (modules, then commands and events) with one
//! entry per line and a trailing comma, so branches that add commands to
//! different modules do not touch the same lines. Keep them that way: add a
//! new entry at its sorted place, never at the end.

pub(crate) mod actions;
pub(crate) mod applications;
pub(crate) mod ask_ai;
pub(crate) mod autostart;
pub(crate) mod catalog;
pub(crate) mod cluster;
pub(crate) mod clusters;
pub(crate) mod debug;
pub(crate) mod exec;
pub(crate) mod files;
pub(crate) mod helm;
pub(crate) mod helm_charts;
pub(crate) mod help;
pub(crate) mod image_scan;
pub(crate) mod image_security;
pub(crate) mod kubectl;
pub(crate) mod links;
pub(crate) mod local_shell;
pub(crate) mod log_flow;
pub(crate) mod log_frame;
pub(crate) mod logs;
pub(crate) mod metrics_addons;
pub(crate) mod overview;
pub(crate) mod pod_env;
pub(crate) mod portforward;
pub(crate) mod prometheus;
pub(crate) mod proxy;
pub(crate) mod raw_body;
pub(crate) mod registry_tags;
pub(crate) mod resources;
pub(crate) mod settings;
pub(crate) mod term_frame;
pub(crate) mod term_out;
pub(crate) mod updater;
pub(crate) mod usage;
pub(crate) mod watch;
pub(crate) mod window;
pub(crate) mod workload_usage;
pub(crate) mod workloads;

#[cfg(test)]
mod mutation_gate;

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
            ask_ai::cmd_ask_ai_setup,
            ask_ai::cmd_ask_ai_skill_remove,
            ask_ai::cmd_ask_ai_start,
            autostart::cmd_autostart_enabled,
            autostart::cmd_autostart_set,
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
            cluster::cmd_server_version,
            cluster::cmd_set_context,
            clusters::cmd_cluster_connect,
            clusters::cmd_cluster_disconnect,
            clusters::cmd_cluster_health,
            clusters::cmd_cluster_reconnect,
            debug::cmd_debug_start,
            debug::cmd_node_shell_cleanup,
            debug::cmd_node_shell_leftovers,
            debug::cmd_node_shell_start,
            exec::cmd_attach_start,
            exec::cmd_exec_ack,
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
            image_scan::cmd_image_scan,
            image_scan::cmd_image_scan_cancel,
            image_scan::cmd_image_scanner_approve,
            image_scan::cmd_image_scanner_forget,
            image_scan::cmd_image_scanner_status,
            image_security::cmd_image_security_image,
            image_security::cmd_image_security_summary,
            kubectl::cmd_kubectl_download,
            kubectl::cmd_kubectl_match,
            links::cmd_check_link,
            links::cmd_object_link,
            links::cmd_take_link,
            local_shell::cmd_local_shell_ack,
            local_shell::cmd_local_shell_close,
            local_shell::cmd_local_shell_input,
            local_shell::cmd_local_shell_resize,
            local_shell::cmd_local_shell_start,
            logs::cmd_log_ack,
            logs::cmd_save_logs,
            logs::cmd_stop_logs,
            logs::cmd_stream_pod_all_logs,
            logs::cmd_stream_pod_logs,
            logs::cmd_stream_workload_logs,
            metrics_addons::cmd_metrics_addon_access,
            metrics_addons::cmd_metrics_addon_install,
            metrics_addons::cmd_metrics_addons,
            overview::cmd_overview_start,
            overview::cmd_overview_stop,
            overview::cmd_overview_usage,
            pod_env::cmd_pod_env,
            pod_env::cmd_reveal_pod_env,
            portforward::cmd_portforward_autostart,
            portforward::cmd_portforward_delete,
            portforward::cmd_portforward_elsewhere,
            portforward::cmd_portforward_list,
            portforward::cmd_portforward_list_all,
            portforward::cmd_portforward_save,
            portforward::cmd_portforward_saved,
            portforward::cmd_portforward_start,
            portforward::cmd_portforward_start_saved,
            portforward::cmd_portforward_stop,
            portforward::cmd_service_ports,
            prometheus::cmd_node_disk_usage,
            prometheus::cmd_prometheus_status,
            proxy::cmd_get_cluster_proxy,
            proxy::cmd_set_cluster_proxy,
            registry_tags::cmd_registry_tags,
            registry_tags::cmd_workload_images,
            resources::cmd_apply_manifests,
            resources::cmd_apply_resource_yaml,
            resources::cmd_delete_resource,
            resources::cmd_describe_resource,
            resources::cmd_get_data_entries,
            resources::cmd_get_related,
            resources::cmd_get_resource_detail,
            resources::cmd_get_resource_yaml,
            resources::cmd_patch_data,
            resources::cmd_reveal_data_value,
            settings::cmd_get_settings,
            settings::cmd_set_context_mode,
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
            crate::catalog::KubeconfigsChanged,
            crate::state::idle::ClusterStateChanged,
            links::LinkPending,
            updater::UpdateProgress,
            window::UnsavedCloseRequested,
        ])
        // Counters and epoch seconds stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}
