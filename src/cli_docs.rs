//! The CLI reference of the docs site (`docs/user/src/reference/cli/`),
//! generated from the clap definitions in `args.rs` (#468).
//!
//! `cargo test --bin nauvi cli_reference` fails when the committed pages are
//! stale; `NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference`
//! rewrites them. Every command must belong to one of [`GROUPS`], and every
//! page must be listed in the book's `SUMMARY.md`.

use crate::args::Cli;
use clap::{Arg, ArgAction, Command, CommandFactory};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// One generated page: file name, title, intro, the top-level commands on it.
pub(crate) struct Group {
    pub file: &'static str,
    pub title: &'static str,
    pub intro: &'static str,
    pub commands: &'static [&'static str],
}

pub(crate) const GROUPS: &[Group] = &[
    Group {
        file: "inspect.md",
        title: "Look at resources",
        intro: "Commands that read the cluster and print what is there. None of them change anything.",
        commands: &[
            "problems",
            "get",
            "describe",
            "yaml",
            "pods",
            "namespaces",
            "nodes",
            "watch",
            "tags",
            "top",
            "vulns",
            "link",
        ],
    },
    Group {
        file: "logs.md",
        title: "Logs",
        intro: "Read or follow the logs of one pod, or of every pod of a workload.",
        commands: &["logs"],
    },
    Group {
        file: "shells.md",
        title: "Shells, debugging and port forwards",
        intro: "Commands that run something in a pod or on a node, or connect a local port to the cluster.",
        commands: &["exec", "attach", "debug", "node-shell", "port-forward"],
    },
    Group {
        file: "actions.md",
        title: "Actions",
        intro: "Commands that change the cluster. Errors say plainly what blocked them: \
                not allowed, already gone, refused by a PodDisruptionBudget.",
        commands: &[
            "scale", "restart", "cordon", "uncordon", "drain", "evict", "trigger", "suspend",
            "resume", "delete", "apply",
        ],
    },
    Group {
        file: "helm.md",
        title: "Helm",
        intro: "Read Helm releases straight from the cluster. No `helm` binary is needed.",
        commands: &["helm"],
    },
    Group {
        file: "mcp.md",
        title: "nauvi mcp",
        intro: "The MCP server for AI assistants. See \
                [Use nauvi from an AI assistant](../../how-to/mcp.md) for how to set it up.",
        commands: &["mcp"],
    },
    Group {
        file: "completions.md",
        title: "Shell completions",
        intro: "Tab completion for bash, zsh, fish, PowerShell and elvish.",
        commands: &["completions"],
    },
];

pub(crate) fn docs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/user/src/reference/cli")
}

/// Every generated page, as (file name, contents).
pub(crate) fn render() -> Vec<(&'static str, String)> {
    let mut root = Cli::command();
    root.build();
    let globals: Vec<&Arg> = root
        .get_arguments()
        .filter(|a| a.is_global_set() && !a.is_hide_set())
        .collect();
    GROUPS
        .iter()
        .map(|g| {
            let mut out = String::new();
            let _ = writeln!(
                out,
                "<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run"
            );
            let _ = writeln!(
                out,
                "     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->"
            );
            let _ = writeln!(out);
            let _ = writeln!(out, "# {}", g.title);
            let _ = writeln!(out);
            let _ = writeln!(out, "{}", g.intro);
            let _ = writeln!(out);
            let _ = writeln!(
                out,
                "Every command also takes the [global options](index.md#global-options) \
                 ({}).",
                globals
                    .iter()
                    .map(|a| format!("`--{}`", a.get_long().unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            for name in g.commands {
                let cmd = root
                    .find_subcommand(name)
                    .unwrap_or_else(|| panic!("no command {name} in args.rs"));
                command(&mut out, &["nauvi"], cmd, 2);
            }
            (g.file, out)
        })
        .collect()
}

fn command(out: &mut String, parents: &[&str], cmd: &Command, level: usize) {
    let mut path: Vec<&str> = parents.to_vec();
    path.push(cmd.get_name());
    let full = path.join(" ");
    let _ = writeln!(out);
    let _ = writeln!(out, "{} `{}`", "#".repeat(level), full);
    let _ = writeln!(out);
    if let Some(about) = cmd.get_long_about().or(cmd.get_about()) {
        let _ = writeln!(out, "{}", sentence(&prose(&about.to_string())));
        let _ = writeln!(out);
    }
    let aliases: Vec<&str> = cmd.get_visible_aliases().collect();
    if !aliases.is_empty() {
        let _ = writeln!(
            out,
            "Also: {}.",
            aliases
                .iter()
                .map(|a| format!("`{a}`"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let _ = writeln!(out);
    }
    let subs: Vec<&Command> = cmd
        .get_subcommands()
        .filter(|c| !c.is_hide_set() && c.get_name() != "help")
        .collect();
    let args: Vec<&Arg> = cmd
        .get_arguments()
        .filter(|a| !a.is_hide_set() && !a.is_global_set())
        .filter(|a| !matches!(a.get_id().as_str(), "help" | "version"))
        .collect();
    let _ = writeln!(out, "```text");
    let _ = writeln!(out, "{}", usage(&full, &args, !subs.is_empty()));
    let _ = writeln!(out, "```");
    if !args.is_empty() {
        let _ = writeln!(out);
        let _ = writeln!(out, "| Argument | What it does |");
        let _ = writeln!(out, "| --- | --- |");
        for a in &args {
            let _ = writeln!(out, "| {} | {} |", arg_name(a), cell(&arg_help(a)));
        }
    }
    for sub in subs {
        command(out, &path, sub, level + 1);
    }
}

fn value_name(a: &Arg) -> String {
    a.get_value_names()
        .and_then(|v| v.first().map(|s| s.to_string()))
        .unwrap_or_else(|| a.get_id().as_str().to_uppercase())
}

fn takes_value(a: &Arg) -> bool {
    matches!(a.get_action(), ArgAction::Set | ArgAction::Append)
}

fn usage(full: &str, args: &[&Arg], has_subs: bool) -> String {
    let mut parts = vec![full.to_string()];
    if has_subs {
        parts.push("<COMMAND>".into());
    }
    if args.iter().any(|a| !a.is_positional()) {
        parts.push("[OPTIONS]".into());
    }
    for a in args.iter().filter(|a| a.is_positional()) {
        let name = value_name(a);
        let many = matches!(a.get_action(), ArgAction::Append);
        let body = if many {
            format!("<{name}>...")
        } else {
            format!("<{name}>")
        };
        let body = if a.is_last_set() {
            format!("-- {body}")
        } else {
            body
        };
        parts.push(if a.is_required_set() {
            body
        } else {
            format!("[{body}]")
        });
    }
    parts.join(" ")
}

fn arg_name(a: &Arg) -> String {
    if a.is_positional() {
        return format!("`<{}>`", value_name(a));
    }
    let mut names = Vec::new();
    if let Some(s) = a.get_short() {
        names.push(format!("-{s}"));
    }
    if let Some(l) = a.get_long() {
        names.push(format!("--{l}"));
    }
    let mut s = names.join(", ");
    if takes_value(a) {
        let _ = write!(s, " <{}>", value_name(a));
    }
    format!("`{s}`")
}

fn arg_help(a: &Arg) -> String {
    let mut s = a
        .get_long_help()
        .or(a.get_help())
        .map(|h| prose(&h.to_string()))
        .unwrap_or_default();
    let possible: Vec<String> = a
        .get_possible_values()
        .iter()
        .filter(|p| !p.is_hide_set())
        .map(|p| format!("`{}`", p.get_name()))
        .collect();
    if !possible.is_empty() && takes_value(a) {
        if !s.is_empty() {
            s.push_str(". ");
        }
        let _ = write!(s, "One of {}", possible.join(", "));
    }
    let defaults: Vec<String> = a
        .get_default_values()
        .iter()
        .map(|d| d.to_string_lossy().into_owned())
        .collect();
    if !defaults.is_empty() && takes_value(a) {
        if !s.is_empty() {
            s.push_str(". ");
        }
        let _ = write!(s, "Default: `{}`", defaults.join(","));
    }
    if a.is_required_set() && !a.is_positional() {
        if !s.is_empty() {
            s.push_str(". ");
        }
        s.push_str("Required");
    }
    s
}

/// Doc comments are wrapped at 80 columns: join the lines of each paragraph.
fn prose(s: &str) -> String {
    s.split("\n\n")
        .map(|p| p.lines().map(str::trim).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// End a paragraph with a full stop, as doc comments for `--help` don't.
fn sentence(s: &str) -> String {
    if s.ends_with(['.', ')', ':', '!', '?']) {
        s.to_string()
    } else {
        format!("{s}.")
    }
}

/// A table cell: one line, pipes escaped.
fn cell(s: &str) -> String {
    s.replace("\n\n", " ").replace('|', "\\|")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn cli_reference_is_up_to_date() {
        let root = Cli::command();
        let grouped: BTreeSet<&str> = GROUPS
            .iter()
            .flat_map(|g| g.commands.iter().copied())
            .collect();
        for c in root.get_subcommands().filter(|c| !c.is_hide_set()) {
            assert!(
                grouped.contains(c.get_name()),
                "`nauvi {}` is on no page of the CLI reference: add it to GROUPS in src/cli_docs.rs",
                c.get_name()
            );
        }
        let summary = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/user/src/SUMMARY.md"),
        )
        .expect("docs/user/src/SUMMARY.md");
        let dir = docs_dir();
        let write = std::env::var_os("NAUVI_WRITE_CLI_DOCS").is_some();
        let mut stale = Vec::new();
        for (file, text) in render() {
            assert!(
                summary.contains(&format!("(reference/cli/{file})")),
                "reference/cli/{file} is not listed in docs/user/src/SUMMARY.md"
            );
            let path = dir.join(file);
            if write {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &text).unwrap();
            } else if std::fs::read_to_string(&path)
                .ok()
                // A Windows checkout may have CRLF line ends.
                .map(|s| s.replace("\r\n", "\n"))
                .as_deref()
                != Some(text.as_str())
            {
                stale.push(file);
            }
        }
        assert!(
            stale.is_empty(),
            "the CLI reference is stale ({stale:?}): run `NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference` and commit docs/user/src/reference/cli/"
        );
    }
}
