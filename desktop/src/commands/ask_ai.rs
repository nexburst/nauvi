//! "Ask AI" (#376): the user's AI CLI in a dock terminal, pointed at a
//! cluster, namespace or object, with the `nauvi` agent skill (#466).
//!
//! It is a local terminal (`local_shell`): the same gate (refused on a
//! read-only context, confirmed on a protected one), the same per-terminal
//! kubeconfig and working directory, and the same input, resize and close
//! commands. The CLI runs in place of the shell; when it exits, the user's
//! shell starts in the same terminal. What it runs and how: see
//! `nauvi::ask_ai`. Nothing goes through a shell command line.
//!
//! Before it starts, the skill for that CLI is written, or updated when the
//! app version changed (`nauvi::ask_ai_skill`); a custom command, or a CLI
//! whose skill cannot be written, gets the same guidance in its first
//! prompt. No MCP server is passed: `nauvi mcp` is opt-in, set up by the
//! user in clients without skills.
//!
//! It starts in the working directory set for the context, else in a
//! folder of its own (`ask-ai` in the app's data folder, #532), never the
//! home folder: AI CLIs scan their folder at start-up, and on macOS
//! reading `~/Pictures` or `~/Documents` from a process nauvi started
//! makes macOS ask for nauvi to access Photos or Documents.

use crate::ask_ai_show::ShowGrant;
use crate::commands::local_shell::{shell_setup, ShellSetup};
use crate::commands::term_frame::TermChannel;
use crate::commands::term_out::{send_closed, send_data, TermOut};
use crate::local_shell::{LocalShell, ShellSpec};
use crate::settings::{Settings, SettingsStore};
use crate::state::mutation::Mutation;
use crate::state::{next_session, LocalShellSession};
use nauvi::ask_ai::{self, Cli, KNOWN_CLIS};
use nauvi::ask_ai_skill::{self as skill, Installed, SkillHome, SkillState, SKILL_HOMES};
use nauvi::links;
use nauvi::{TempExt, TempKubeconfig};
use serde::Serialize;
use specta::Type;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State};

/// The version the skill is written for: the app's.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    /// The [`AskAiSkill::id`] of the skill it reads (`""`: none, the
    /// guidance goes in its first prompt).
    skill: String,
}

/// The nauvi skill in one place AI CLIs read skills from.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AskAiSkill {
    /// `claude` or `agents`.
    id: String,
    /// The CLIs that read it.
    label: String,
    /// Its folder (`…/skills/nauvi`).
    path: String,
    /// `missing`, `current`, `outdated` (written by another version; Ask AI
    /// updates it) or `foreign` (not nauvi's: left alone).
    state: String,
    /// For `foreign`: why.
    detail: String,
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
    /// The `nauvi` CLI the skill runs (`""`: not on `PATH`).
    nauvi: String,
    /// Why the custom command set in Settings cannot run (`""`: it can, or
    /// none is set).
    custom_error: String,
    /// The skill in each place (`[]`: no home folder).
    skills: Vec<AskAiSkill>,
}

/// A started Ask AI terminal.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AskAiStarted {
    session: String,
    context: String,
    namespace: String,
    /// The CLI's name.
    cli: String,
    /// What the CLI got: `new` (the skill was installed now), `updated`,
    /// `current`, or `prompt` (the guidance is in its first prompt).
    skill: String,
    /// The skill's folder (`""` for `prompt`).
    skill_path: String,
    /// Why the skill could not be written (`""`: it was, or none is used).
    skill_error: String,
    /// The `nauvi` CLI is on `PATH`.
    nauvi: bool,
    /// As in a local shell: the downloaded kubectl first on `PATH`.
    kubectl: String,
    /// The folder it runs in.
    cwd: String,
    /// `cwd` is the working directory set for the context (else it is Ask
    /// AI's own folder).
    cwd_set: bool,
}

/// Where the user's skill folders are.
struct Homes {
    user: Option<PathBuf>,
    claude_config: Option<PathBuf>,
}

impl Homes {
    fn of_this_process() -> Self {
        let home = nauvi::catalog::expand_home("~");
        Self {
            user: home.is_absolute().then_some(home),
            claude_config: std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
        }
    }

    /// The skills folder of `h` (`None`: no home folder).
    fn root(&self, h: &SkillHome) -> Option<PathBuf> {
        let user = self.user.as_deref()?;
        Some(skill::skills_root(h, user, self.claude_config.as_deref()))
    }
}

/// The CLIs Ask AI can start, from this process's `PATH` (the login
/// shell's, imported at start-up) and the settings, and where the skill is.
/// Reads only.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_ask_ai_setup(settings: State<'_, Arc<SettingsStore>>) -> AskAiSetup {
    setup(
        &settings.get(),
        std::env::var_os("PATH").as_deref(),
        &Homes::of_this_process(),
    )
}

/// Remove the nauvi skill of place `id` (`claude` or `agents`): only the
/// file nauvi wrote, then its folder if it is empty. Ask AI writes it again
/// the next time it starts a CLI that reads it.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_ask_ai_skill_remove(
    settings: State<'_, Arc<SettingsStore>>,
    id: String,
) -> Result<AskAiSetup, String> {
    let homes = Homes::of_this_process();
    let home = SKILL_HOMES
        .iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("Ask AI has no skill place {id:?}"))?;
    let root = homes
        .root(home)
        .ok_or("Cannot find your home folder, so there is no skill to remove")?;
    skill::remove(&root)?;
    tracing::info!("Ask AI: removed the nauvi skill from {}", root.display());
    Ok(setup(
        &settings.get(),
        std::env::var_os("PATH").as_deref(),
        &homes,
    ))
}

fn skill_rows(homes: &Homes) -> Vec<AskAiSkill> {
    SKILL_HOMES
        .iter()
        .filter_map(|h| {
            let dir = homes.root(h)?.join(skill::SKILL_NAME);
            let (state, detail) = match skill::state(&dir, APP_VERSION) {
                SkillState::Missing => ("missing", String::new()),
                SkillState::Current => ("current", String::new()),
                SkillState::Outdated => ("outdated", String::new()),
                SkillState::Foreign(why) => ("foreign", why),
            };
            Some(AskAiSkill {
                id: h.id.into(),
                label: h.label.into(),
                path: dir.display().to_string(),
                state: state.into(),
                detail,
            })
        })
        .collect()
}

fn setup(settings: &Settings, path: Option<&OsStr>, homes: &Homes) -> AskAiSetup {
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
            skill: skill::home_for_cli(k.id)
                .map(|h| h.id.to_string())
                .unwrap_or_default(),
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
                skill: String::new(),
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
        skills: skill_rows(homes),
    }
}

/// The custom command's program and arguments.
fn custom_cli(settings: &Settings, path: Option<&OsStr>) -> Result<(PathBuf, Vec<String>), String> {
    let mut words = ask_ai::split_command(&settings.ask_ai_command)?;
    let program = ask_ai::custom_program(&words.remove(0), path)?;
    Ok((program, words))
}

/// The `nauvi` CLI on `path`, unless it is this app itself (the skill's
/// `nauvi problems` would open a window).
fn nauvi_cli(path: Option<&OsStr>) -> Option<PathBuf> {
    let found = ask_ai::find_program("nauvi", path)?;
    let canonical = |p: &Path| std::fs::canonicalize(p).ok();
    match std::env::current_exe().ok() {
        Some(me) if canonical(&me).is_some() && canonical(&me) == canonical(&found) => None,
        _ => Some(found),
    }
}

/// What the CLI `kind` gets: the skill written into its place, or (custom,
/// or the skill cannot be written) the guidance in the prompt. Returns
/// (skill, skill_path, skill_error, prompt).
fn give_skill(
    kind: &Cli,
    cli_id: &str,
    prompt: String,
    homes: &Homes,
) -> (String, String, String, String) {
    let in_prompt = |error: String, prompt: &str| {
        (
            "prompt".to_string(),
            String::new(),
            error,
            ask_ai::with_guidance(prompt),
        )
    };
    if matches!(kind, Cli::Custom(_)) {
        return in_prompt(String::new(), &prompt);
    }
    let Some((home, root)) = skill::home_for_cli(cli_id).and_then(|h| Some((h, homes.root(h)?)))
    else {
        return in_prompt(
            "Cannot find your home folder for the nauvi skill".into(),
            &prompt,
        );
    };
    let dir = root.join(skill::SKILL_NAME).display().to_string();
    match skill::install(&root, APP_VERSION) {
        Ok(done) => {
            let what = match done {
                Installed::New => "new",
                Installed::Updated => "updated",
                Installed::Unchanged => "current",
            };
            if done != Installed::Unchanged {
                tracing::info!("Ask AI: wrote the nauvi skill for {} at {dir}", home.label);
            }
            (what.into(), dir, String::new(), prompt)
        }
        Err(e) => {
            tracing::warn!("Ask AI: {e}");
            in_prompt(e, &prompt)
        }
    }
}

/// Start the AI CLI `cli` (an id of [`AskAiSetup::found`]) in a new local
/// terminal at the app's context and `namespace` (`null`: the context's
/// own), with `prompt` as its first message, after writing (or updating)
/// the nauvi skill it reads. Refused on a read-only context and confirmed
/// on a protected one, like a local terminal. What the CLI runs in it is
/// up to the CLI's own approval prompts.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_ask_ai_start(
    cluster: Mutation,
    settings: State<'_, Arc<SettingsStore>>,
    namespace: Option<String>,
    cli: String,
    prompt: String,
    cols: u16,
    rows: u16,
    on_output: TermChannel,
) -> Result<AskAiStarted, String> {
    let current = settings.get();
    let path = std::env::var_os("PATH");
    let path = path.as_deref();
    let (kind, program, label) = resolve(&cli, &current, path)?;
    let id = cluster.id().to_string();
    let ShellSetup {
        spec: shell,
        generated,
        temp,
        kubectl,
    } = shell_setup(&cluster, &settings, namespace.as_deref()).await?;
    let cwd_set = !current
        .contexts
        .get(&cluster.target()?.target.id)
        .is_none_or(|c| c.shell_cwd.trim().is_empty());
    let cwd = match (cwd_set, shell.cwd.clone()) {
        (true, Some(dir)) => dir,
        _ => {
            let data = cluster
                .app()
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("cannot find the app's data folder: {e}"))?;
            own_folder(&data)?
        }
    };
    let prompt = ask_ai::clean_prompt(&prompt);
    let (skill, skill_path, skill_error, prompt) =
        give_skill(&kind, &cli, prompt, &Homes::of_this_process());
    // The skill names `nauvi`: without a usable one (none, or this app,
    // which would open a window) the model is told not to run it.
    let nauvi = nauvi_cli(path).is_some();
    let prompt = ask_ai::session_prompt(prompt, nauvi);

    let mut files = vec![temp];
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
    let launch = ask_ai::launch(&kind, program, &prompt, prompt_file.as_deref());
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
    let context_id = cluster.target()?.target.id;
    let on_output = TermOut::new(on_output);
    // `nauvi show` (#548), only with the setting on when it starts: a
    // token for this session, gone when its terminal's process ends.
    let grant = match current.ask_ai_open_views {
        true => Some(ShowGrant::new(
            cluster.label(),
            &context_id,
            on_output.clone(),
        )?),
        false => None,
    };
    // The CLI where the shell would run: its working directory and
    // environment, plus what the CLI needs for this session.
    let spec = ShellSpec {
        program: launch.program.into_os_string(),
        args: launch.args,
        cwd: Some(cwd.clone()),
        env: shell
            .env
            .into_iter()
            .chain(launch.env)
            .chain(link_env(&context_id, &generated.context, grant.as_ref()))
            .collect(),
    };
    tracing::info!("Ask AI: starting {label} at {id} (skill: {skill})");
    let session = next_session("local");
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
            drop(grant);
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
        skill,
        skill_path,
        skill_error,
        nauvi,
        kubectl,
        cwd: cwd.display().to_string(),
        cwd_set,
    })
}

/// What `nauvi link` and `nauvi show` read in the session (#548): the
/// context's catalog id and its name in the terminal's kubeconfig, and with
/// a grant its token and this app's program.
fn link_env(
    context_id: &str,
    kube_context: &str,
    grant: Option<&ShowGrant>,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = vec![
        (links::LINK_CONTEXT_ENV.into(), context_id.into()),
        (links::LINK_KUBE_CONTEXT_ENV.into(), kube_context.into()),
    ];
    if let (Some(grant), Ok(app)) = (grant, std::env::current_exe()) {
        env.push((links::SHOW_SESSION_ENV.into(), grant.token().into()));
        env.push((links::SHOW_APP_ENV.into(), app.into_os_string()));
    }
    env
}

/// Ask AI's own folder in the app's data folder `data`, created (only the
/// user can open it) if missing. Not a link: the CLI scans what is in it.
fn own_folder(data: &Path) -> Result<PathBuf, String> {
    let dir = data.join("ask-ai");
    let fail = |e: &dyn std::fmt::Display| {
        format!(
            "Cannot create Ask AI's folder {}: {e}. Set a working directory in the cluster's \
             settings to run it there.",
            dir.display()
        )
    };
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).map_err(|e| fail(&e))?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|e| fail(&e))?;
    if !meta.is_dir() {
        return Err(fail(&"it is not a folder"));
    }
    Ok(dir)
}

/// `text` without control, zero-width or bidi characters (a context name
/// is the kubeconfig's text, printed in the terminal).
#[cfg(unix)]
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !ask_ai::is_hidden_char(*c))
        .collect()
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
        let got = setup(&s, Some(&path), &NO_HOME);
        let ids: Vec<_> = got.found.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["codex", "gemini"]);
        assert_eq!(got.missing[0].id, "claude");
        assert!(got.missing[0].install.contains("claude-code"));
        assert_eq!(got.chosen, "codex");
        assert_eq!(got.nauvi, dir.join("nauvi").display().to_string());

        s.ask_ai_cli = "gemini".into();
        assert_eq!(setup(&s, Some(&path), &NO_HOME).chosen, "gemini");
        // A CLI that is not found is not chosen.
        s.ask_ai_cli = "claude".into();
        assert_eq!(setup(&s, Some(&path), &NO_HOME).chosen, "codex");

        s.ask_ai_cli = "custom".into();
        s.ask_ai_command = "my-ai --flag 'two words'".into();
        let got = setup(&s, Some(&path), &NO_HOME);
        assert_eq!(got.chosen, "custom");
        assert_eq!(
            got.found.last().unwrap().path,
            dir.join("my-ai").display().to_string()
        );
        let (kind, program, _) = resolve("custom", &s, Some(&path)).unwrap();
        assert_eq!(program, dir.join("my-ai"));
        assert_eq!(kind, Cli::Custom(vec!["--flag".into(), "two words".into()]));

        s.ask_ai_command = "not-there".into();
        let got = setup(&s, Some(&path), &NO_HOME);
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

    /// The note after the CLI names the context: nothing in its name may
    /// act on the terminal or reorder the text (security review).
    #[cfg(unix)]
    #[test]
    fn plain_drops_control_zero_width_and_bidi_characters() {
        let name: String = ["prod", "\u{1b}[2J", "\u{0}", "-", "\u{9b}", "eu"].concat();
        assert_eq!(plain(&name), "prod[2J-eu");
        let hidden: String = [0x200B, 0x200D, 0x2060, 0xFEFF, 0x202E, 0x2066, 0x2069]
            .iter()
            .map(|&u| char::from_u32(u).unwrap())
            .collect();
        assert_eq!(plain(&format!("a{hidden}b")), "ab");
        assert_eq!(plain("café-東京"), "café-東京");
    }

    #[test]
    fn nothing_found_on_an_empty_path() {
        let got = setup(&Settings::default(), None, &NO_HOME);
        assert!(got.found.is_empty());
        assert_eq!(got.missing.len(), KNOWN_CLIS.len());
        assert_eq!(got.chosen, "");
        assert_eq!(got.nauvi, "");
        assert!(got.skills.is_empty());
    }

    /// A `nauvi` on PATH that is this app is not offered: the skill's
    /// `nauvi problems` would open a window. The session is told so.
    #[cfg(unix)]
    #[test]
    fn the_app_itself_is_not_the_nauvi_cli() {
        let dir = std::env::temp_dir().join(format!("nauvi-ask-ai-self-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::env::current_exe().unwrap();
        std::os::unix::fs::symlink(&me, dir.join("nauvi")).unwrap();
        let path = dir.clone().into_os_string();
        assert_eq!(nauvi_cli(Some(&path)), None);
        assert_eq!(setup(&Settings::default(), Some(&path), &NO_HOME).nauvi, "");
        let prompt = ask_ai::session_prompt("Look".into(), nauvi_cli(Some(&path)).is_some());
        assert!(prompt.contains("don't run `nauvi`"), "{prompt}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Without a working directory for the context, Ask AI runs in a
    /// folder of its own, created once, only the user's (#532).
    #[test]
    fn its_own_folder_is_created_once_and_private() {
        let data = std::env::temp_dir().join(format!("nauvi-ask-ai-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let dir = own_folder(&data).unwrap();
        assert_eq!(dir, data.join("ask-ai"));
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::write(dir.join("kept"), "x").unwrap();
        assert_eq!(own_folder(&data).unwrap(), dir);
        assert!(dir.join("kept").exists());

        // A file in its place is not used.
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, "x").unwrap();
        let err = own_folder(&data).unwrap_err();
        assert!(err.contains("Cannot create Ask AI's folder"), "{err}");
        // Nor a link to another folder.
        #[cfg(unix)]
        {
            std::fs::remove_file(&dir).unwrap();
            std::os::unix::fs::symlink(std::env::temp_dir(), &dir).unwrap();
            assert!(own_folder(&data).unwrap_err().contains("not a folder"));
        }
        std::fs::remove_dir_all(&data).unwrap();
    }

    const NO_HOME: Homes = Homes {
        user: None,
        claude_config: None,
    };

    /// The skill goes where each CLI reads it, once; a custom command and
    /// a place nauvi cannot write get the guidance in the prompt.
    #[test]
    fn each_cli_gets_the_skill_or_the_guidance() {
        let home = std::env::temp_dir().join(format!("nauvi-ask-ai-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let homes = Homes {
            user: Some(home.clone()),
            claude_config: None,
        };
        let states = |h: &Homes| -> Vec<(String, String)> {
            skill_rows(h).into_iter().map(|s| (s.id, s.state)).collect()
        };
        assert_eq!(
            states(&homes),
            [
                ("claude".into(), "missing".into()),
                ("agents".into(), "missing".into())
            ]
        );

        let (what, path, err, prompt) = give_skill(&Cli::Claude, "claude", "Look".into(), &homes);
        assert_eq!(
            (what.as_str(), err.as_str(), prompt.as_str()),
            ("new", "", "Look")
        );
        assert_eq!(
            path,
            home.join(".claude")
                .join("skills")
                .join("nauvi")
                .display()
                .to_string()
        );
        let (what, ..) = give_skill(&Cli::Claude, "claude", "Look".into(), &homes);
        assert_eq!(what, "current");
        // Codex and Gemini CLI share one copy.
        assert_eq!(
            give_skill(&Cli::Codex, "codex", "x".into(), &homes).0,
            "new"
        );
        assert_eq!(
            give_skill(&Cli::Gemini, "gemini", "x".into(), &homes).0,
            "current"
        );
        assert_eq!(
            states(&homes),
            [
                ("claude".into(), "current".into()),
                ("agents".into(), "current".into())
            ]
        );

        // A custom command: the guidance in its prompt, no file.
        let (what, path, _, prompt) =
            give_skill(&Cli::Custom(vec![]), "custom", "Look".into(), &homes);
        assert_eq!((what.as_str(), path.as_str()), ("prompt", ""));
        assert!(
            prompt.contains("nauvi problems") && prompt.ends_with("Look"),
            "{prompt}"
        );

        // A skill of the user's own is kept; the CLI gets the guidance.
        let file = home.join(".claude/skills/nauvi/SKILL.md");
        std::fs::write(&file, "my own").unwrap();
        let (what, _, err, prompt) = give_skill(&Cli::Claude, "claude", "Look".into(), &homes);
        assert_eq!(what, "prompt");
        assert!(err.contains("did not write"), "{err}");
        assert!(prompt.contains("nauvi problems"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "my own");
        assert_eq!(skill_rows(&homes)[0].state, "foreign");

        // Without a home folder: the guidance in the prompt.
        assert_eq!(
            give_skill(&Cli::Claude, "claude", "x".into(), &NO_HOME).0,
            "prompt"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }
}
