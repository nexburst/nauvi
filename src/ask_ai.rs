//! "Ask AI" (#376): the user's own AI coding CLI (Claude Code, Codex,
//! Gemini CLI, or a command of their own) started in a terminal, with
//! `nauvi mcp` for one context offered to it for that session only.
//!
//! nauvi never downloads or installs a CLI: it only runs a program found on
//! `PATH`, or the command the user set. Nothing here builds a shell command
//! line. The program and each argument are separate values, and the prompt
//! (which holds names from the cluster) is one argument of its own or a
//! file, so no name can become a flag of a shell. The MCP server is passed
//! the way each CLI takes a config for one session (a file, `-c` overrides,
//! an environment variable), never by editing the CLI's own config files.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// A CLI nauvi knows how to start with a prompt and an MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownCli {
    /// What the settings store (`claude`).
    pub id: &'static str,
    /// The program looked up on `PATH`.
    pub program: &'static str,
    pub label: &'static str,
    /// How its makers say to install it (shown, never run).
    pub install: &'static str,
}

/// The known CLIs, in the order they are offered.
pub const KNOWN_CLIS: &[KnownCli] = &[
    KnownCli {
        id: "claude",
        program: "claude",
        label: "Claude Code",
        install: "npm install -g @anthropic-ai/claude-code",
    },
    KnownCli {
        id: "codex",
        program: "codex",
        label: "Codex",
        install: "npm install -g @openai/codex",
    },
    KnownCli {
        id: "gemini",
        program: "gemini",
        label: "Gemini CLI",
        install: "npm install -g @google/gemini-cli",
    },
];

/// The id of the user's own command.
pub const CUSTOM: &str = "custom";

/// The name the MCP server gets in the CLI (its tools are `nauvi`'s).
pub const MCP_SERVER: &str = "nauvi";

/// At most this many characters of prompt are passed on.
pub const MAX_PROMPT: usize = 4000;

/// Which CLI to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
    Gemini,
    /// The user's command: the arguments after its program.
    Custom(Vec<String>),
}

impl Cli {
    /// A known CLI by its id.
    pub fn known(id: &str) -> Option<Cli> {
        match id {
            "claude" => Some(Cli::Claude),
            "codex" => Some(Cli::Codex),
            "gemini" => Some(Cli::Gemini),
            _ => None,
        }
    }
}

/// `name` in one of the directories of `path` (a `PATH` value), as an
/// executable file. Relative directories (`.`, an empty entry) are skipped:
/// they would find a program in whatever folder the app runs in. On Windows
/// only `<name>.exe` counts: a `.cmd` or `.bat` runs through `cmd.exe`, which
/// parses its arguments again.
pub fn find_program(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(&file))
        .find(|p| is_executable(p))
}

/// Whether `path` is a file this user may run.
pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The program of a custom command: a path (`~/` allowed) to an
/// executable file, or a name found on `path`.
pub fn custom_program(word: &str, path: Option<&OsStr>) -> Result<PathBuf, String> {
    if word.contains(['/', '\\']) {
        let p = crate::catalog::expand_home(word);
        if !p.is_absolute() {
            return Err(format!(
                "The AI command {word} is a relative path: use a full path or a name on PATH"
            ));
        }
        if !is_executable(&p) {
            return Err(format!(
                "The AI command {word} is not a program that can be run"
            ));
        }
        return Ok(p);
    }
    find_program(word, path).ok_or_else(|| format!("The AI command {word} is not on PATH"))
}

/// Split the user's command into words, as a POSIX shell would split
/// plain text: spaces separate, `'…'` and `"…"` keep spaces, a backslash
/// keeps the next quote, backslash or space. Nothing is expanded (no `$`,
/// `~`, globs, pipes): the words are run as they are.
pub fn split_command(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err("The AI command has a ' without its closing '".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if matches!(chars.peek(), Some('"' | '\\')) => {
                            word.push(chars.next().unwrap_or('\\'))
                        }
                        Some(c) => word.push(c),
                        None => return Err("The AI command has a \" without its closing \"".into()),
                    }
                }
            }
            '\\' if matches!(chars.peek(), Some(n) if *n == '"' || *n == '\'' || *n == '\\' || n.is_whitespace()) =>
            {
                in_word = true;
                word.extend(chars.next());
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    if words.is_empty() {
        return Err("No AI command is set: set one in Settings, AI".into());
    }
    Ok(words)
}

/// The prompt as it is passed on: control characters (an escape sequence
/// the terminal would act on, a NUL) dropped, tabs as spaces, at most
/// [`MAX_PROMPT`] characters.
pub fn clean_prompt(text: &str) -> String {
    text.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_PROMPT)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The arguments of `nauvi mcp` for `context` (`""`: the kubeconfig's
/// current context). `--context=<name>` in one argument, so a context name
/// that starts with `-` stays the value.
pub fn mcp_args(context: &str, allow_writes: bool) -> Vec<String> {
    let mut args = Vec::new();
    if !context.is_empty() {
        args.push(format!("--context={context}"));
    }
    args.push("mcp".into());
    if allow_writes {
        args.push("--allow-writes".into());
    }
    args
}

/// The `mcpServers` JSON that Claude Code (`--mcp-config`), Gemini CLI and
/// most other clients read: one server, [`MCP_SERVER`], running `command`
/// with `args` and `env` set on top of the CLI's environment.
pub fn mcp_servers_json(command: &Path, args: &[String], env: &[(String, String)]) -> String {
    let env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let mut server = serde_json::json!({
        "command": command.to_string_lossy(),
        "args": args,
    });
    if !env.is_empty() {
        server["env"] = serde_json::Value::Object(env);
    }
    let file = serde_json::json!({ "mcpServers": { MCP_SERVER: server } });
    serde_json::to_string_pretty(&file).unwrap_or_default()
}

/// The MCP server a session offers.
#[derive(Debug, Clone)]
pub struct Mcp<'a> {
    /// The [`mcp_servers_json`] file written for this session.
    pub config: &'a Path,
    /// The `nauvi` CLI.
    pub command: &'a Path,
    /// Its [`mcp_args`].
    pub args: &'a [String],
}

/// What to start: the program, its arguments and the environment set on
/// top of the terminal's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// The environment variable Gemini CLI reads its system defaults from:
/// the lowest of its settings layers, so the user's settings (and an
/// administrator's system settings) still win.
const GEMINI_DEFAULTS: &str = "GEMINI_CLI_SYSTEM_DEFAULTS_PATH";
/// For a custom command: the [`mcp_servers_json`] file.
pub const CUSTOM_MCP_ENV: &str = "NAUVI_MCP_CONFIG";
/// For a custom command: a file with the prompt.
pub const CUSTOM_PROMPT_ENV: &str = "NAUVI_PROMPT_FILE";

/// How to start `cli` (found at `program`) with `prompt` (already
/// [`clean_prompt`]ed; `""`: none) and `mcp`. `prompt_file` holds the
/// prompt for a custom command, which gets it only that way.
///
/// - Claude Code: `--mcp-config=<file>`, then `--` and the prompt.
/// - Codex: `-c mcp_servers.nauvi.*=…` overrides (TOML values), with
///   `KUBECONFIG` passed through by name, then `--` and the prompt.
/// - Gemini CLI: the file as its system defaults
///   (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`), `--prompt-interactive=<prompt>`.
/// - Custom: its own arguments; `NAUVI_MCP_CONFIG` and `NAUVI_PROMPT_FILE`.
pub fn launch(
    cli: &Cli,
    program: PathBuf,
    prompt: &str,
    mcp: Option<&Mcp<'_>>,
    prompt_file: Option<&Path>,
) -> Launch {
    let mut args: Vec<OsString> = Vec::new();
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    // After `--`, a prompt that starts with `-` is not read as a flag.
    let positional = |args: &mut Vec<OsString>| {
        if !prompt.is_empty() {
            args.push("--".into());
            args.push(prompt.into());
        }
    };
    match cli {
        Cli::Claude => {
            if let Some(m) = mcp {
                let mut flag = OsString::from("--mcp-config=");
                flag.push(m.config);
                args.push(flag);
            }
            positional(&mut args);
        }
        Cli::Codex => {
            if let Some(m) = mcp {
                let key = |k: &str| format!("mcp_servers.{MCP_SERVER}.{k}");
                let toml_str = |s: &str| serde_json::Value::String(s.into()).to_string();
                let command = toml_str(&m.command.to_string_lossy());
                let list = serde_json::to_string(m.args).unwrap_or_default();
                for value in [
                    format!("{}={command}", key("command")),
                    format!("{}={list}", key("args")),
                    format!("{}=[\"KUBECONFIG\"]", key("env_vars")),
                ] {
                    args.push("-c".into());
                    args.push(value.into());
                }
            }
            positional(&mut args);
        }
        Cli::Gemini => {
            if let Some(m) = mcp {
                env.push((GEMINI_DEFAULTS.into(), m.config.into()));
            }
            if !prompt.is_empty() {
                args.push(format!("--prompt-interactive={prompt}").into());
            }
        }
        Cli::Custom(own) => {
            args.extend(own.iter().map(OsString::from));
            if let Some(m) = mcp {
                env.push((CUSTOM_MCP_ENV.into(), m.config.into()));
            }
            if let Some(f) = prompt_file {
                env.push((CUSTOM_PROMPT_ENV.into(), f.into()));
            }
        }
    }
    Launch { program, args, env }
}

/// The script that runs the CLI, then the user's shell in its place, in the
/// same terminal. It is a constant: the note, the shell, the program and
/// every argument come as positional parameters (`"$@"` keeps each one
/// whole and is never parsed again), so nothing in them can become shell
/// syntax. `trap :` keeps this script alive through a Ctrl-C meant for the
/// CLI (the CLI itself gets the default handler: a caught signal is reset
/// by `exec`).
pub const THEN_SHELL_SCRIPT: &str =
    r#"trap : INT QUIT; note=$1; shell=$2; shift 2; "$@"; printf '%s' "$note"; exec "$shell" -l"#;

/// `launch`, then (when it exits) `shell -l` in the same terminal, after
/// `note`: `/bin/sh -c` [`THEN_SHELL_SCRIPT`] with everything as
/// arguments. Unix only (a terminal's session ends with its first process
/// on macOS, so the shell cannot be started after it from outside).
pub fn then_shell(launch: Launch, shell: &OsStr, note: &str) -> Launch {
    let mut args: Vec<OsString> = vec![
        "-c".into(),
        THEN_SHELL_SCRIPT.into(),
        "nauvi-ask-ai".into(),
        note.into(),
        shell.into(),
        launch.program.into_os_string(),
    ];
    args.extend(launch.args);
    Launch {
        program: "/bin/sh".into(),
        args,
        env: launch.env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wrapper keeps every argument whole and runs none of it: a
    /// prompt full of shell syntax reaches the program as one argument,
    /// then the "shell" runs.
    #[cfg(unix)]
    #[test]
    fn then_shell_passes_arguments_through_untouched() {
        let dir = std::env::temp_dir().join(format!("nauvi-then-shell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let evil = format!(
            "x\"; touch {m}; echo \"$(touch {m})\" `touch {m}` '; touch {m}; '\n-n --flag",
            m = marker.display()
        );
        let inner = Launch {
            program: "/usr/bin/printf".into(),
            args: vec!["<%s>\\n".into(), evil.clone().into(), "two words".into()],
            env: vec![],
        };
        // `echo` stands in for the user's shell (it gets `-l`).
        let l = then_shell(inner, OsStr::new("/bin/echo"), "NOTE\n");
        assert_eq!(l.program, PathBuf::from("/bin/sh"));
        let out = std::process::Command::new(&l.program)
            .args(&l.args)
            .output()
            .unwrap();
        let out = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out, format!("<{evil}>\n<two words>\nNOTE\n-l\n"));
        assert!(!marker.exists(), "an argument ran as shell code");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn strs(v: &[OsString]) -> Vec<String> {
        v.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn split_command_keeps_quoted_words_and_expands_nothing() {
        assert_eq!(
            split_command("  my-ai --model 'big one' \"a \\\"b\\\"\" $HOME ~/x a\\ b ").unwrap(),
            ["my-ai", "--model", "big one", "a \"b\"", "$HOME", "~/x", "a b"]
        );
        assert_eq!(
            split_command(r"C:\Tools\ai.exe --x").unwrap(),
            [r"C:\Tools\ai.exe", "--x"]
        );
        assert_eq!(split_command("''").unwrap(), [""]);
        assert!(split_command("   ").is_err());
        assert!(split_command("ai 'open").is_err());
        assert!(split_command("ai \"open").is_err());
        // Shell syntax is only text.
        assert_eq!(split_command("a;b|c").unwrap(), ["a;b|c"]);
    }

    #[test]
    fn clean_prompt_drops_control_characters_and_caps() {
        assert_eq!(
            clean_prompt("  Look at\tpod\u{1b}[31m x\u{0}\r\nnext  "),
            "Look at pod[31m x\nnext"
        );
        assert_eq!(
            clean_prompt(&"é".repeat(MAX_PROMPT + 10)).chars().count(),
            MAX_PROMPT
        );
    }

    #[test]
    fn mcp_args_keep_the_context_in_one_argument() {
        assert_eq!(mcp_args("kind-x", false), ["--context=kind-x", "mcp"]);
        assert_eq!(
            mcp_args("-evil --allow-writes", false),
            ["--context=-evil --allow-writes", "mcp"]
        );
        assert_eq!(mcp_args("", true), ["mcp", "--allow-writes"]);
    }

    #[test]
    fn mcp_json_has_one_server() {
        let json = mcp_servers_json(
            Path::new("/usr/bin/nauvi"),
            &mcp_args("a\"b", false),
            &[("KUBECONFIG".into(), "/tmp/k.yaml".into())],
        );
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let s = &v["mcpServers"]["nauvi"];
        assert_eq!(s["command"], "/usr/bin/nauvi");
        assert_eq!(s["args"], serde_json::json!(["--context=a\"b", "mcp"]));
        assert_eq!(s["env"]["KUBECONFIG"], "/tmp/k.yaml");
        let bare = mcp_servers_json(Path::new("/n"), &[], &[]);
        assert!(!bare.contains("env"), "{bare}");
    }

    const PROMPT: &str = "--dangerously-skip-permissions; rm -rf ~ $(id)";

    fn mcp_for<'a>(args: &'a [String]) -> Mcp<'a> {
        Mcp {
            config: Path::new("/tmp/nauvi-shell-1-2.json"),
            command: Path::new("/opt/nauvi bin/nauvi"),
            args,
        }
    }

    #[test]
    fn claude_gets_the_config_file_and_the_prompt_after_dashes() {
        let args = mcp_args("kind-x", false);
        let l = launch(
            &Cli::Claude,
            "/bin/claude".into(),
            PROMPT,
            Some(&mcp_for(&args)),
            None,
        );
        assert_eq!(
            strs(&l.args),
            ["--mcp-config=/tmp/nauvi-shell-1-2.json", "--", PROMPT]
        );
        assert!(l.env.is_empty());
        let l = launch(&Cli::Claude, "/bin/claude".into(), "", None, None);
        assert!(l.args.is_empty());
    }

    #[test]
    fn codex_gets_toml_overrides() {
        let args = mcp_args("ctx \"q\"", true);
        let l = launch(
            &Cli::Codex,
            "/bin/codex".into(),
            PROMPT,
            Some(&mcp_for(&args)),
            None,
        );
        assert_eq!(
            strs(&l.args),
            [
                "-c",
                r#"mcp_servers.nauvi.command="/opt/nauvi bin/nauvi""#,
                "-c",
                r#"mcp_servers.nauvi.args=["--context=ctx \"q\"","mcp","--allow-writes"]"#,
                "-c",
                r#"mcp_servers.nauvi.env_vars=["KUBECONFIG"]"#,
                "--",
                PROMPT,
            ]
        );
    }

    #[test]
    fn gemini_gets_the_file_as_system_defaults() {
        let args = mcp_args("c", false);
        let l = launch(
            &Cli::Gemini,
            "/bin/gemini".into(),
            PROMPT,
            Some(&mcp_for(&args)),
            None,
        );
        assert_eq!(strs(&l.args), [format!("--prompt-interactive={PROMPT}")]);
        assert_eq!(
            l.env,
            [(
                OsString::from(GEMINI_DEFAULTS),
                OsString::from("/tmp/nauvi-shell-1-2.json")
            )]
        );
    }

    #[test]
    fn custom_gets_files_by_environment_only() {
        let args = mcp_args("c", false);
        let l = launch(
            &Cli::Custom(vec!["--flag".into()]),
            "/bin/ai".into(),
            PROMPT,
            Some(&mcp_for(&args)),
            Some(Path::new("/tmp/p.md")),
        );
        assert_eq!(strs(&l.args), ["--flag"]);
        let env: Vec<_> = l
            .env
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        assert_eq!(
            env,
            [
                (
                    CUSTOM_MCP_ENV.to_string(),
                    "/tmp/nauvi-shell-1-2.json".to_string()
                ),
                (CUSTOM_PROMPT_ENV.to_string(), "/tmp/p.md".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn programs_are_found_in_absolute_path_entries_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nauvi-ask-ai-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("my-ai");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plain = dir.join("not-exec");
        std::fs::write(&plain, "x").unwrap();
        let path = std::env::join_paths([Path::new("."), &dir]).unwrap();
        assert_eq!(find_program("my-ai", Some(&path)), Some(exe.clone()));
        assert_eq!(find_program("not-exec", Some(&path)), None);
        assert_eq!(find_program("../my-ai", Some(&path)), None);
        // A relative entry is never searched.
        let rel = OsString::from(".");
        let cwd_exe = std::env::current_dir().unwrap().join("my-ai");
        if !cwd_exe.exists() {
            assert_eq!(find_program("my-ai", Some(&rel)), None);
        }
        assert_eq!(custom_program(&exe.to_string_lossy(), None).unwrap(), exe);
        assert!(custom_program("./my-ai", Some(&path)).is_err());
        assert!(custom_program(&plain.to_string_lossy(), None).is_err());
        assert_eq!(custom_program("my-ai", Some(&path)).unwrap(), exe);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
