//! `nauvi mcp`: a Model Context Protocol server over stdio (#298), for
//! AI assistants (Claude Code, Claude Desktop, other MCP clients).
//!
//! - `server`: the protocol, through the `rmcp` SDK (the only file that uses it)
//! - `tools`: the tool catalogue and the dispatcher
//! - `read_tools`: list, get, describe, logs, events, top
//! - `write_tools`: scale, restart, delete, apply (only with `--allow-writes`)
//! - `redact`: Secret values and last-applied, never returned
//! - `limits`: caps on lines and bytes per call
//!
//! It uses the kubeconfig the CLI uses (`--kubeconfig`, else `KUBECONFIG`
//! and `~/.kube/config`) and its current context, or `--context`. It never
//! reads the app's added kubeconfig sources, so it never runs their exec
//! plugins. Write tools follow the app's per-context mode (#338): refused
//! on a context the app marks read-only or protected. Diagnostics go to stderr: stdout carries the protocol.

mod limits;
mod read_tools;
mod redact;
mod server;
mod tools;
mod write_tools;

pub use server::NauviMcp;
pub use tools::{catalogue, ToolSpec};

use anyhow::Result;
use rmcp::ServiceExt;
use std::path::PathBuf;

/// How `nauvi mcp` was started.
#[derive(Debug, Clone, Default)]
pub struct McpOptions {
    /// Offer the tools that change the cluster.
    pub allow_writes: bool,
    pub kubeconfig: Option<PathBuf>,
    pub context: Option<String>,
    /// The app's settings file, for the context's read-only or protected
    /// mode (#338). `None`: where the desktop app keeps it.
    pub app_settings: Option<PathBuf>,
}

/// Serve MCP on stdin/stdout until the client closes stdin.
pub async fn serve_stdio(opts: McpOptions) -> Result<()> {
    // A plugin waiting for a login nobody will do must not hang a tool call.
    crate::exec_credentials::set_plugin_timeout(crate::exec_credentials::MCP_PLUGIN_TIMEOUT);
    let service = NauviMcp::new(opts).serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
