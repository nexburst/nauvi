// Table headers keep the literal column names inline with their widths.
#![allow(clippy::print_literal)]

// One module per concern. Their items are re-exported at the crate root, so
// callers keep using `nauvi::get_pods`, `nauvi::LogOptions`, ...
mod access;
mod age;
mod cli;
mod client;
mod describe;
mod exec;
mod get;
mod logs;
mod metrics;
mod overview;
mod pods;
mod portforward;
mod prometheus;
mod prometheus_disk;
mod shell_kubeconfig;
mod usage_history;
mod usage_reference;
mod workload_usage;

pub mod action_access;
pub mod actions;
pub mod applications;
pub mod attach;
pub mod auth;
pub mod bounded_list;
pub mod catalog;
pub mod debug;
pub mod errors;
pub mod exec_credentials;
pub mod helm;
pub mod liveness;
#[cfg(feature = "mcp")]
pub mod mcp;
pub mod node_shell;
pub mod poll;
pub mod reconnect;
pub mod resources;
pub mod terminal;
pub mod watch;
pub mod workload_logs;

pub use access::*;
pub(crate) use age::*;
pub use catalog::{list_contexts, ContextInfo, ContextTarget};
pub use cli::*;
pub use client::*;
pub use describe::*;
pub use errors::error_text;
pub use exec::*;
pub use get::*;
pub use logs::*;
pub use metrics::*;
pub use overview::*;
pub use pods::*;
pub use portforward::*;
pub use prometheus::*;
pub use prometheus_disk::*;
pub use shell_kubeconfig::*;
pub use usage_history::*;
pub use usage_reference::*;
pub use workload_logs::*;
pub use workload_usage::*;
