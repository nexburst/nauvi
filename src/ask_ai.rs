//! "Ask AI" (#376): the user's own AI coding CLI (Claude Code, Codex,
//! Gemini CLI, or a command of their own) started in a terminal whose
//! kubeconfig points at one context. What it knows about nauvi comes from
//! the `nauvi` agent skill (`crate::ask_ai_skill`, #466), or for a custom
//! command from its first prompt; no MCP server is passed (`nauvi mcp`
//! stays in the CLI, opt-in for clients without skills).
//!
//! nauvi never downloads or installs a CLI: it only runs a program found on
//! `PATH`, or the command the user set. Nothing here builds a shell command
//! line. The program and each argument are separate values, and the prompt
//! (which holds names from the cluster) is one argument of its own or a
//! file, so no name can become a flag of a shell.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// A CLI nauvi knows how to start with a prompt.
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

/// Whether `c` is never shown as written: a control character (an escape
/// sequence the terminal would act on, a NUL), a zero-width character
/// (U+200B to U+200D, U+2060, U+FEFF) or a bidi control (U+202A to U+202E,
/// U+2066 to U+2069), which can make text read other than it is. The same
/// set as the UI's `oneLine` drops.
pub fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c as u32,
            0x200B..=0x200D | 0x2060 | 0xFEFF | 0x202A..=0x202E | 0x2066..=0x2069
        )
}

/// The prompt as it is passed on: [`is_hidden_char`]s dropped (but line
/// breaks kept), tabs as spaces, at most [`MAX_PROMPT`] characters.
pub fn clean_prompt(text: &str) -> String {
    text.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| *c == '\n' || !is_hidden_char(*c))
        .take(MAX_PROMPT)
        .collect::<String>()
        .trim()
        .to_string()
}

/// What to start: the program, its arguments and the environment set on
/// top of the terminal's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// For a custom command: a file with the prompt.
pub const CUSTOM_PROMPT_ENV: &str = "NAUVI_PROMPT_FILE";

/// `prompt` (already [`clean_prompt`]ed) after the skill's guidance, for a
/// CLI that gets no skill: a custom command, or one whose skill could not
/// be written. The guidance is nauvi's own text, so it is not capped.
pub fn with_guidance(prompt: &str) -> String {
    format!(
        "{}\n---\n\n{prompt}",
        crate::ask_ai_skill::GUIDANCE.trim_end()
    )
}

/// What the model is told when the `nauvi` on PATH cannot be used: there is
/// none, or it is the desktop app itself (running it would open a window).
pub const NO_NAUVI_NOTE: &str = "In this terminal `nauvi` is not the nauvi CLI (it is missing, or it is the \
                                 nauvi desktop app, which would open a window): don't run `nauvi`. Use kubectl \
                                 only, and don't print Secret values unless I ask.";

/// `prompt` for a session: with [`NO_NAUVI_NOTE`] at its end unless
/// `nauvi_usable`.
pub fn session_prompt(prompt: String, nauvi_usable: bool) -> String {
    if nauvi_usable {
        prompt
    } else if prompt.is_empty() {
        NO_NAUVI_NOTE.to_string()
    } else {
        format!("{prompt}\n{NO_NAUVI_NOTE}")
    }
}

/// How to start `cli` (found at `program`) with `prompt` (`""`: none).
/// `prompt_file` holds the prompt for a custom command, which gets it only
/// that way. Every CLI gets `NAUVI_ASK_AI=1`, so the skill knows this
/// terminal's KUBECONFIG was set by nauvi for one cluster.
///
/// - Claude Code and Codex: `--` and the prompt.
/// - Gemini CLI: `--prompt-interactive=<prompt>`.
/// - Custom: its own arguments; `NAUVI_PROMPT_FILE`.
pub fn launch(cli: &Cli, program: PathBuf, prompt: &str, prompt_file: Option<&Path>) -> Launch {
    let mut args: Vec<OsString> = Vec::new();
    let mut env: Vec<(OsString, OsString)> =
        vec![(crate::ask_ai_skill::ASK_AI_ENV.into(), "1".into())];
    match cli {
        // After `--`, a prompt that starts with `-` is not read as a flag.
        Cli::Claude | Cli::Codex => {
            if !prompt.is_empty() {
                args.push("--".into());
                args.push(prompt.into());
            }
        }
        Cli::Gemini => {
            if !prompt.is_empty() {
                args.push(format!("--prompt-interactive={prompt}").into());
            }
        }
        Cli::Custom(own) => {
            args.extend(own.iter().map(OsString::from));
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

    /// Zero-width characters and bidi controls go too (security review).
    #[test]
    fn clean_prompt_drops_zero_width_and_bidi_characters() {
        let hidden = [
            0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066,
            0x2067, 0x2068, 0x2069,
        ];
        let text: String = hidden
            .iter()
            .map(|&u| format!("a{}", char::from_u32(u).unwrap()))
            .collect();
        assert_eq!(clean_prompt(&text), "a".repeat(hidden.len()));
        for u in hidden {
            assert!(is_hidden_char(char::from_u32(u).unwrap()), "{u:x}");
        }
        // Text around them, and other non-ASCII letters, stay.
        for c in ['é', 'ж', '中', ' ', '-'] {
            assert!(!is_hidden_char(c), "{c}");
        }
    }

    const PROMPT: &str = "--dangerously-skip-permissions; rm -rf ~ $(id)";

    #[test]
    fn claude_and_codex_get_the_prompt_after_dashes_and_no_mcp() {
        for cli in [Cli::Claude, Cli::Codex] {
            let l = launch(&cli, "/bin/ai".into(), PROMPT, None);
            assert_eq!(strs(&l.args), ["--", PROMPT]);
            assert_eq!(l.env, ask_ai_env());
            let l = launch(&cli, "/bin/ai".into(), "", None);
            assert!(l.args.is_empty());
        }
    }

    #[test]
    fn gemini_gets_the_prompt_in_one_flag() {
        let l = launch(&Cli::Gemini, "/bin/gemini".into(), PROMPT, None);
        assert_eq!(strs(&l.args), [format!("--prompt-interactive={PROMPT}")]);
        assert_eq!(l.env, ask_ai_env());
    }

    #[test]
    fn custom_gets_the_prompt_file_by_environment_only() {
        let l = launch(
            &Cli::Custom(vec!["--flag".into()]),
            "/bin/ai".into(),
            PROMPT,
            Some(Path::new("/tmp/p.md")),
        );
        assert_eq!(strs(&l.args), ["--flag"]);
        let mut want = ask_ai_env();
        want.push((
            OsString::from(CUSTOM_PROMPT_ENV),
            OsString::from("/tmp/p.md"),
        ));
        assert_eq!(l.env, want);
    }

    fn ask_ai_env() -> Vec<(OsString, OsString)> {
        vec![(OsString::from("NAUVI_ASK_AI"), OsString::from("1"))]
    }

    /// Without a usable `nauvi` (none, or the app itself) the model is told
    /// not to run it (review of #474).
    #[test]
    fn without_a_usable_nauvi_the_prompt_says_so() {
        assert_eq!(session_prompt("Look".into(), true), "Look");
        let p = session_prompt("Look".into(), false);
        assert!(p.starts_with("Look\n") && p.ends_with(NO_NAUVI_NOTE), "{p}");
        assert!(NO_NAUVI_NOTE.contains("don't run `nauvi`"));
        assert_eq!(session_prompt(String::new(), false), NO_NAUVI_NOTE);
    }

    #[test]
    fn guidance_comes_before_the_prompt() {
        let p = with_guidance("Look at pod x");
        assert!(p.starts_with("# Kubernetes with kubectl and nauvi"), "{p}");
        assert!(p.ends_with("---\n\nLook at pod x"), "{p}");
        assert!(p.contains("nauvi problems"));
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
