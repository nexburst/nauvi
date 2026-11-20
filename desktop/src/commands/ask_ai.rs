//! "Ask AI" (#376): the user's own AI CLI in a dock terminal, pointed at a
//! cluster, namespace or object, with `nauvi mcp` for the same context.
//!
//! It is a local terminal (`local_shell`): the same gate (refused on a
//! read-only context, confirmed on a protected one), the same per-terminal
//! kubeconfig and working directory, and the same input, resize and close
//! commands. The CLI runs in place of the shell; when it exits, the user's
//! shell starts in the same terminal. What it runs and how: see
//! `nauvi::ask_ai`. Nothing goes through a shell command line.

use crate::commands::local_shell::{shell_setup, ShellSetup};
use crate::commands::term_frame::TermChannel;
use crate::commands::term_out::{send_closed, send_data, TermOut};
use crate::local_shell::{LocalShell, ShellSpec};
use crate::settings::{Settings, SettingsStore};
use crate::state::mutation::Mutation;
use crate::state::{next_session, LocalShellSession};
use nauvi::ask_ai::{self, Cli, KNOWN_CLIS};
use nauvi::context_mode::ContextMode;
use nauvi::{TempExt, TempKubeconfig};
use serde::Serialize;
use specta::Type;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

/// A CLI Ask AI can start.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AskAiCli {
    /// `claude`, `codex`, `gemini` or `custom`.
    id: String,
    label: String,
    /// Where it was found (`""`: not found).
    path: String,
    /// How to install it (`""` for the custom command).
    install: String,
}

/// What Ask AI can start on this machine.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AskAiSetup {
    /// The known CLIs found on `PATH`, then the custom command if it is set
    /// and can run.
    found: Vec<AskAiCli>,
    /// The known CLIs not on `PATH`, with how to install them.
    missing: Vec<AskAiCli>,
    /// The one Ask AI starts: the one set in Settings if it is found, else
    /// the first found (`""`: none).
    chosen: String,
    /// The `nauvi` CLI that serves the MCP tools (`""`: not on `PATH`).
    nauvi: String,
    /// Why the custom command set in Settings cannot run (`""`: it can, or
    /// none is set).
    custom_error: String,
}

/// A started Ask AI terminal.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AskAiStarted {
    session: String,
    context: String,
    namespace: String,
    /// The CLI's name.
    cli: String,
    /// The nauvi MCP tools offered: `read-only`, `writes`, or `""` (the
    /// `nauvi` CLI is not on `PATH`).
    mcp: String,
    /// As in a local shell: the downloaded kubectl first on `PATH`.
    kubectl: String,
}

/// The CLIs Ask AI can start, from this process's `PATH` (the login
/// shell's, imported at start-up) and the settings. Reads only.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_ask_ai_setup(settings: State<'_, Arc<SettingsStore>>) -> AskAiSetup {
    setup(&settings.get(), std::env::var_os("PATH").as_deref())
}

fn setup(settings: &Settings, path: Option<&OsStr>) -> AskAiSetup {
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for k in KNOWN_CLIS {
        let at = ask_ai::find_program(k.program, path);
        let cli = AskAiCli {
            id: k.id.into(),
            label: k.label.into(),
            path: at
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            install: k.install.into(),
        };
        if at.is_some() {
            found.push(cli);
        } else {
            missing.push(cli);
        }
    }
    let mut custom_error = String::new();
    if !settings.ask_ai_command.is_empty() {
        match custom_cli(settings, path) {
            Ok((program, _)) => found.push(AskAiCli {
                id: ask_ai::CUSTOM.into(),
                label: "Custom command".into(),
                path: program.display().to_string(),
                install: String::new(),
            }),
            Err(e) => custom_error = e,
        }
    }
    let chosen = found
        .iter()
        .find(|c| c.id == settings.ask_ai_cli)
        .or(found.first())
        .map(|c| c.id.clone())
        .unwrap_or_default();
    AskAiSetup {
        found,
        missing,
        chosen,
        nauvi: nauvi_cli(path)
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        custom_error,
    }
}

/// The custom command's program and arguments.
fn custom_cli(settings: &Settings, path: Option<&OsStr>) -> Result<(PathBuf, Vec<String>), String> {
    let mut words = ask_ai::split_command(&settings.ask_ai_command)?;
    let program = ask_ai::custom_program(&words.remove(0), path)?;
    Ok((program, words))
}

/// The `nauvi` CLI on `path`, unless it is this app itself (a `nauvi mcp`
/// that opens a window would never answer).
fn nauvi_cli(path: Option<&OsStr>) -> Option<PathBuf> {
    let found = ask_ai::find_program("nauvi", path)?;
    let canonical = |p: &std::path::Path| std::fs::canonicalize(p).ok();
    match std::env::current_exe().ok() {
        Some(me) if canonical(&me).is_some() && canonical(&me) == canonical(&found) => None,
        _ => Some(found),
    }
}

/// Start the AI CLI `cli` (an id of [`AskAiSetup::found`]) in a new local
/// terminal at the app's context and `namespace` (`null`: the context's
/// own), with `prompt` as its first message, and the nauvi MCP tools for
/// that context: read-only, unless `allow_writes` and the context is
/// normal. On a protected or read-only context writes are refused here,
/// and `nauvi mcp` itself refuses them too.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_ask_ai_start(
    cluster: Mutation,
    settings: State<'_, Arc<SettingsStore>>,
    namespace: Option<String>,
    cli: String,
    prompt: String,
    allow_writes: bool,
    cols: u16,
    rows: u16,
    on_output: TermChannel,
) -> Result<AskAiStarted, String> {
    let current = settings.get();
    let path = std::env::var_os("PATH");
    let path = path.as_deref();
    let (kind, program, label) = resolve(&cli, &current, path)?;
    let id = cluster.id().to_string();
    let mode = settings.context_mode(&id);
    if allow_writes && mode != ContextMode::Normal {
        return Err(format!(
            "{id} is {}: the assistant gets only the read-only tools",
            mode.label()
        ));
    }
    let ShellSetup {
        spec: shell,
        generated,
        temp,
        kubeconfig,
        kubectl,
    } = shell_setup(&cluster, &settings, namespace.as_deref()).await?;
    let prompt = ask_ai::clean_prompt(&prompt);

    let mut files = vec![temp];
    let nauvi = nauvi_cli(path);
    let mcp_args = ask_ai::mcp_args(&generated.context, allow_writes);
    let config = match &nauvi {
        Some(nauvi) => {
            // The same KUBECONFIG as the terminal, in a file only the user
            // can read, deleted with the tab.
            let env = [(
                "KUBECONFIG".to_string(),
                kubeconfig.to_string_lossy().into_owned(),
            )];
            let json = ask_ai::mcp_servers_json(nauvi, &mcp_args, &env);
            let file =
                TempKubeconfig::create_file(TempExt::Json, &json).map_err(|e| format!("{e:#}"))?;
            let p = file.path().to_path_buf();
            files.push(file);
            Some(p)
        }
        None => None,
    };
    let prompt_file = match kind {
        Cli::Custom(_) => {
            let file = TempKubeconfig::create_file(TempExt::Text, &prompt)
                .map_err(|e| format!("{e:#}"))?;
            let p = file.path().to_path_buf();
            files.push(file);
            Some(p)
        }
        _ => None,
    };
    let mcp = match (&nauvi, &config) {
        (Some(command), Some(config)) => Some(ask_ai::Mcp {
            config,
            command,
            args: &mcp_args,
        }),
        _ => None,
    };
    let launch = ask_ai::launch(
        &kind,
        program,
        &prompt,
        mcp.as_ref(),
        prompt_file.as_deref(),
    );
    // When the CLI exits, the user's shell in its place (Unix; on Windows
    // the tab ends with the CLI).
    #[cfg(unix)]
    let launch = {
        let note = format!(
            "\n\x1b[90m{label} exited. This is your shell; kubectl still uses context {}, \
             namespace {}.\x1b[0m\n",
            plain(&generated.context),
            plain(&generated.namespace)
        );
        ask_ai::then_shell(launch, &shell.program, &note)
    };
    // The CLI where the shell would run: its working directory and
    // environment, plus what the CLI needs for this session.
    let spec = ShellSpec {
        program: launch.program.into_os_string(),
        args: launch.args,
        cwd: shell.cwd,
        env: shell.env.into_iter().chain(launch.env).collect(),
    };
    tracing::info!(
        "Ask AI: starting {label} at {id} (MCP: {})",
        if nauvi.is_none() {
            "none"
        } else if allow_writes {
            "writes"
        } else {
            "read-only"
        }
    );
    let session = next_session("local");
    let on_output = TermOut::new(on_output);
    let (out, exit_out) = (on_output.clone(), on_output.clone());
    let terminal = LocalShell::spawn(
        &spec,
        cols,
        rows,
        files,
        move |data| {
            send_data(&out, data.into_bytes());
        },
        move || {
            send_closed(&exit_out);
        },
    )
    .map_err(|e| e.replace("the shell", &label))?;
    cluster.add_local_shell(
        session.clone(),
        LocalShellSession {
            shell: terminal,
            out: on_output,
        },
    );
    Ok(AskAiStarted {
        session,
        context: generated.context,
        namespace: generated.namespace,
        cli: label,
        mcp: match (&nauvi, allow_writes) {
            (None, _) => String::new(),
            (Some(_), false) => "read-only".into(),
            (Some(_), true) => "writes".into(),
        },
        kubectl,
    })
}

/// `text` without control characters (a context name is the kubeconfig's
/// text, printed in the terminal).
#[cfg(unix)]
fn plain(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

/// The CLI `id`, its program and its name.
fn resolve(
    id: &str,
    settings: &Settings,
    path: Option<&OsStr>,
) -> Result<(Cli, PathBuf, String), String> {
    if id == ask_ai::CUSTOM {
        let (program, args) = custom_cli(settings, path)?;
        return Ok((Cli::Custom(args), program, "The AI command".into()));
    }
    let known = KNOWN_CLIS
        .iter()
        .find(|k| k.id == id)
        .ok_or_else(|| format!("Ask AI does not know the CLI {id:?}"))?;
    let program = ask_ai::find_program(known.program, path).ok_or_else(|| {
        format!(
            "{} ({}) is not on PATH. Install it ({}), or pick another CLI in Settings, AI.",
            known.label, known.program, known.install
        )
    })?;
    let kind = Cli::known(id).ok_or_else(|| format!("Ask AI does not know the CLI {id:?}"))?;
    Ok((kind, program, known.label.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn bin_dir(names: &[&str]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "nauvi-ask-ai-setup-{}-{}",
            std::process::id(),
            names.join("-")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for n in names {
            let p = dir.join(n);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    #[cfg(unix)]
    #[test]
    fn setup_lists_what_is_on_path_and_picks_the_setting() {
        let dir = bin_dir(&["codex", "gemini", "nauvi", "my-ai"]);
        let path = dir.clone().into_os_string();
        let mut s = Settings::default();
        let got = setup(&s, Some(&path));
        let ids: Vec<_> = got.found.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["codex", "gemini"]);
        assert_eq!(got.missing[0].id, "claude");
        assert!(got.missing[0].install.contains("claude-code"));
        assert_eq!(got.chosen, "codex");
        assert_eq!(got.nauvi, dir.join("nauvi").display().to_string());

        s.ask_ai_cli = "gemini".into();
        assert_eq!(setup(&s, Some(&path)).chosen, "gemini");
        // A CLI that is not found is not chosen.
        s.ask_ai_cli = "claude".into();
        assert_eq!(setup(&s, Some(&path)).chosen, "codex");

        s.ask_ai_cli = "custom".into();
        s.ask_ai_command = "my-ai --flag 'two words'".into();
        let got = setup(&s, Some(&path));
        assert_eq!(got.chosen, "custom");
        assert_eq!(
            got.found.last().unwrap().path,
            dir.join("my-ai").display().to_string()
        );
        let (kind, program, _) = resolve("custom", &s, Some(&path)).unwrap();
        assert_eq!(program, dir.join("my-ai"));
        assert_eq!(kind, Cli::Custom(vec!["--flag".into(), "two words".into()]));

        s.ask_ai_command = "not-there".into();
        let got = setup(&s, Some(&path));
        assert!(
            got.custom_error.contains("not on PATH"),
            "{}",
            got.custom_error
        );
        assert_eq!(got.chosen, "codex");

        let err = resolve("claude", &s, Some(&path)).unwrap_err();
        assert!(
            err.contains("not on PATH") && err.contains("npm install"),
            "{err}"
        );
        assert!(resolve("rm", &s, Some(&path)).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_found_on_an_empty_path() {
        let got = setup(&Settings::default(), None);
        assert!(got.found.is_empty());
        assert_eq!(got.missing.len(), KNOWN_CLIS.len());
        assert_eq!(got.chosen, "");
        assert_eq!(got.nauvi, "");
    }
}
