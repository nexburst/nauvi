//! Per-context read-only and protected modes (#338).
//!
//! A context can be marked **read-only** (every change to the cluster is
//! refused) or **protected** (every change needs the context's name typed
//! as a confirmation). The desktop app keeps the mode in its settings and
//! checks it in one gate that every mutating command declares; `nauvi mcp`
//! reads the same settings file and refuses its write tools on a context
//! that is not in the normal mode.
//!
//! What counts as a change: anything that writes to the API server
//! (actions, deletes, applies, Secret and ConfigMap edits, Helm installs,
//! upgrades, rollbacks and uninstalls, metrics add-on installs, debug
//! containers and node shell pods) and anything that hands out a shell
//! that could (exec, attach, node shells, local shells with the context's
//! kubeconfig). Port-forwards are not: they only read through a tunnel,
//! so both modes allow them, as they allow logs.

use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};

/// How much a context lets the app change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ContextMode {
    #[default]
    Normal,
    /// Every change is refused.
    ReadOnly,
    /// Every change needs the context's name typed as a confirmation.
    Protected,
}

/// Read leniently: a value that is not a known mode (a typo in a
/// hand-edited file, a mode from a newer version) is read-only, the
/// safest one, rather than normal.
impl<'de> Deserialize<'de> for ContextMode {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        Ok(match &v {
            serde_json::Value::Null => Self::Normal,
            serde_json::Value::String(s) if s == "normal" => Self::Normal,
            serde_json::Value::String(s) if s == "protected" => Self::Protected,
            _ => Self::ReadOnly,
        })
    }
}

impl ContextMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::ReadOnly => "read-only",
            Self::Protected => "protected",
        }
    }
}

/// Why a change to `context` in `mode` is refused, or `None` when it may
/// go ahead. `confirm` is what the user typed: in protected mode it must be
/// the context's name exactly.
pub fn refusal(mode: ContextMode, context: &str, confirm: &str) -> Option<String> {
    match mode {
        ContextMode::Normal => None,
        ContextMode::ReadOnly => Some(read_only_reason(context)),
        ContextMode::Protected if !context.is_empty() && confirm == context => None,
        ContextMode::Protected if confirm.is_empty() => Some(format!(
            "{context} is protected: type the context name to confirm this change"
        )),
        ContextMode::Protected => Some(format!(
            "{context} is protected: the confirmation does not match the context name, \
             so nothing was changed"
        )),
    }
}

/// The reason given for anything refused on a read-only context.
pub fn read_only_reason(context: &str) -> String {
    format!("{context} is read-only: changes to this cluster are turned off")
}

/// Whether the object action `id` (an [`ActionId`](crate::actions::ActionId)
/// in camelCase, or the panel's `"logs"`, `"shell"`, `"edit"`) changes the
/// cluster or opens a shell, so a read-only context refuses it. Logs and
/// port-forwards only read.
pub fn action_mutates(id: &str) -> bool {
    !matches!(id, "logs" | "portForward")
}

/// The access answers of `ids` with the mode applied: on a read-only
/// context every action that changes the cluster is refused with the mode
/// as the reason, whatever RBAC said (#338, composing with #340).
pub fn apply_to_access(
    mode: ContextMode,
    context: &str,
    access: Vec<crate::action_access::ActionAccess>,
) -> Vec<crate::action_access::ActionAccess> {
    if mode != ContextMode::ReadOnly {
        return access;
    }
    access
        .into_iter()
        .map(|mut a| {
            if action_mutates(&a.id) {
                a.allowed = false;
                a.reason = read_only_reason(context);
            }
            a
        })
        .collect()
}

/// The app's settings file, as the desktop app keeps it
/// (`app_config_dir()/settings.json` of `com.nauvi.app`), for `nauvi mcp`.
pub fn app_settings_path() -> Option<PathBuf> {
    const ID: &str = "com.nauvi.app";
    let dir = if cfg!(target_os = "macos") {
        home::home_dir()?.join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(d) => PathBuf::from(d),
            None => home::home_dir()?.join(".config"),
        }
    };
    Some(dir.join(ID).join("settings.json"))
}

/// The mode of context `id` in the app's settings at `path`. A missing
/// file or context is normal. A file that cannot be read or parsed is
/// read-only: the CLI cannot tell whether the context was protected.
pub fn mode_in_settings(path: &Path, id: &str) -> ContextMode {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ContextMode::Normal,
        Err(_) => return ContextMode::ReadOnly,
    };
    mode_in_settings_text(&text, id)
}

/// The mode the app gives a context the CLI reaches, or why it cannot be
/// told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliMode {
    Known(ContextMode),
    /// The app has settings, but its catalog has no such context.
    Unknown(String),
}

/// Every catalog id the app may give `context` from `kubeconfig` (`None`:
/// the default kubeconfig): the ids of the contexts of that name whose file
/// is that file, in catalogs built from the app's added `sources` exactly as
/// the app builds them ([`crate::catalog::load_catalog`]). The id is the
/// context's name unless an earlier source has one of that name, e.g.
/// `prod (work.yaml)`, and which one comes first depends on the app's own
/// default kubeconfig, which the CLI cannot see (its `KUBECONFIG` may be an
/// added file, which the catalog then reads as the default one). So the
/// catalog is built with the CLI's default kubeconfig, with
/// `~/.kube/config`, and with none, and every match counts.
pub fn app_context_ids(
    sources: &[PathBuf],
    pasted_dir: Option<PathBuf>,
    kubeconfig: Option<&Path>,
    context: &str,
) -> Vec<String> {
    let (inputs, files) = cli_catalogs(sources, pasted_dir, kubeconfig);
    ids_in_catalogs(&inputs, &files, context)
}

/// The catalogs the CLI builds to find a context's ids (see
/// [`app_context_ids`]), and the files the CLI reads the context from.
fn cli_catalogs(
    sources: &[PathBuf],
    pasted_dir: Option<PathBuf>,
    kubeconfig: Option<&Path>,
) -> (Vec<crate::catalog::CatalogInput>, Vec<PathBuf>) {
    use crate::catalog::{default_kubeconfig_paths, CatalogInput};
    let cli_defaults = default_kubeconfig_paths();
    let files = match kubeconfig {
        Some(p) => vec![p.to_path_buf()],
        None => cli_defaults.clone(),
    };
    let input = |default_paths: Vec<PathBuf>| CatalogInput {
        default_paths,
        extra: sources.to_vec(),
        pasted_dir: pasted_dir.clone(),
    };
    let mut inputs = vec![input(cli_defaults), input(Vec::new())];
    if let Some(home) = home::home_dir() {
        inputs.push(input(vec![home.join(".kube").join("config")]));
    }
    (inputs, files)
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Every (context name, canonical file) the catalogs of `inputs` have.
fn known_contexts(inputs: &[crate::catalog::CatalogInput]) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for input in inputs {
        for c in crate::catalog::load_catalog(input).contexts {
            let entry = (c.context, canonical(Path::new(&c.file)));
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
    }
    out
}

/// Whether the stored context id `id` may name `context` from one of
/// `files` (canonical), read by meaning rather than by string: the app
/// names a context `name`, `name (file name)`, `name (path)` or
/// `name (path) #n` ([`crate::catalog::unique_id`]), and which one it
/// gets depends on the app's own default kubeconfig. `known` is every
/// (context, canonical file) the CLI can see. An id that cannot be
/// resolved to a file counts as a match: when in doubt, be strict.
fn id_may_name(id: &str, context: &str, files: &[PathBuf], known: &[(String, PathBuf)]) -> bool {
    // The files that have a context of that name, filtered by `keep`;
    // none at all means the id cannot be resolved.
    let resolve = |keep: &dyn Fn(&Path) -> bool| {
        let found: Vec<&PathBuf> = known
            .iter()
            .filter(|(c, f)| c == context && keep(f))
            .map(|(_, f)| f)
            .collect();
        found.is_empty() || found.iter().any(|f| files.contains(f))
    };
    if id == context {
        // The first file with that context in the app's order: unknown.
        return resolve(&|_| true);
    }
    let Some(rest) = id.strip_prefix(&format!("{context} (")) else {
        return false;
    };
    // `X)` or `X) #n`.
    let inner = match rest.rsplit_once(") #") {
        Some((x, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => x,
        _ => match rest.strip_suffix(')') {
            Some(x) => x,
            None => return false,
        },
    };
    let path = Path::new(inner);
    if path.is_absolute() || inner.contains('/') || inner.contains('\\') {
        return match std::fs::canonicalize(path) {
            Ok(c) => files.contains(&c),
            Err(_) => true,
        };
    }
    resolve(&|f: &Path| f.file_name().is_some_and(|n| n.to_string_lossy() == inner))
}

/// The modes of the stored entries that may name `context` from `files`
/// ([`id_may_name`]).
fn stored_modes(
    text: &str,
    context: &str,
    files: &[PathBuf],
    known: &[(String, PathBuf)],
) -> Vec<ContextMode> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![ContextMode::ReadOnly];
    };
    let Some(contexts) = v.get("contexts").and_then(|c| c.as_object()) else {
        return Vec::new();
    };
    let files: Vec<PathBuf> = files.iter().map(|f| canonical(f)).collect();
    contexts
        .iter()
        .filter(|(id, _)| id_may_name(id, context, &files, known))
        .map(|(id, _)| mode_in_settings_text(text, id))
        .collect()
}

/// [`app_context_ids`] over the catalogs of `inputs`, for `files`.
fn ids_in_catalogs(
    inputs: &[crate::catalog::CatalogInput],
    files: &[PathBuf],
    context: &str,
) -> Vec<String> {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let wanted: Vec<PathBuf> = files.iter().map(|f| canon(f)).collect();
    let mut ids: Vec<String> = Vec::new();
    for input in inputs {
        let catalog = crate::catalog::load_catalog(input);
        for c in &catalog.contexts {
            if c.context == context
                && wanted.contains(&canon(Path::new(&c.file)))
                && !ids.contains(&c.name)
            {
                ids.push(c.name.clone());
            }
        }
    }
    ids
}

/// The strictest of `modes`: read-only, then protected, then normal.
pub fn strictest(modes: impl IntoIterator<Item = ContextMode>) -> ContextMode {
    let rank = |m: ContextMode| match m {
        ContextMode::Normal => 0,
        ContextMode::Protected => 1,
        ContextMode::ReadOnly => 2,
    };
    modes
        .into_iter()
        .max_by_key(|m| rank(*m))
        .unwrap_or_default()
}

/// The mode of `context` from `kubeconfig` in the app's settings at
/// `settings_path`, keyed by the context's catalog ids ([`app_context_ids`]):
/// the strictest of their modes.
/// No settings file: normal (the app never marked anything). A file that
/// cannot be read: read-only. A context the app's catalog does not have:
/// [`CliMode::Unknown`], which `nauvi mcp` treats as refusing writes.
pub fn mode_for_cli(settings_path: &Path, kubeconfig: Option<&Path>, context: &str) -> CliMode {
    let text = match std::fs::read_to_string(settings_path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return CliMode::Known(ContextMode::Normal)
        }
        Err(_) => return CliMode::Known(ContextMode::ReadOnly),
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return CliMode::Known(ContextMode::ReadOnly);
    };
    let sources: Vec<PathBuf> = v
        .get("kubeconfig_sources")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str())
                .map(crate::catalog::expand_home)
                .collect()
        })
        .unwrap_or_default();
    // Where the app keeps pasted kubeconfigs: `<config dir>/kubeconfigs`.
    let pasted = settings_path.parent().map(|d| d.join("kubeconfigs"));
    let (inputs, files) = cli_catalogs(&sources, pasted, kubeconfig);
    let ids = ids_in_catalogs(&inputs, &files, context);
    let known = known_contexts(&inputs);
    mode_by_meaning(&text, &ids, kubeconfig, context, &files, &known)
}

/// [`mode_of_ids`] of the ids the CLI's catalogs give the context, made
/// stricter by every stored entry that may name it ([`stored_modes`]).
fn mode_by_meaning(
    text: &str,
    ids: &[String],
    kubeconfig: Option<&Path>,
    context: &str,
    files: &[PathBuf],
    known: &[(String, PathBuf)],
) -> CliMode {
    let stored = stored_modes(text, context, files, known);
    match mode_of_ids(text, ids, kubeconfig, context) {
        CliMode::Known(m) => CliMode::Known(strictest(std::iter::once(m).chain(stored))),
        CliMode::Unknown(_) if !stored.is_empty() => CliMode::Known(strictest(stored)),
        unknown => unknown,
    }
}

/// The strictest mode among `ids` in the settings `text`, or why there is
/// none to check.
fn mode_of_ids(text: &str, ids: &[String], kubeconfig: Option<&Path>, context: &str) -> CliMode {
    match ids {
        [] => CliMode::Unknown(format!(
            "context {context}{} is not in nauvi's cluster catalog, so its read-only or \
             protected setting cannot be checked",
            kubeconfig
                .map(|p| format!(" of {}", p.display()))
                .unwrap_or_default()
        )),
        ids => CliMode::Known(strictest(
            ids.iter().map(|id| mode_in_settings_text(text, id)),
        )),
    }
}

fn mode_in_settings_text(text: &str, id: &str) -> ContextMode {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return ContextMode::ReadOnly;
    };
    match v
        .get("contexts")
        .and_then(|c| c.get(id))
        .and_then(|c| c.get("mode"))
    {
        None => ContextMode::Normal,
        Some(m) => serde_json::from_value(m.clone()).unwrap_or(ContextMode::ReadOnly),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_allows_everything() {
        assert_eq!(refusal(ContextMode::Normal, "prod", ""), None);
    }

    #[test]
    fn read_only_refuses_even_with_a_confirmation() {
        let r = refusal(ContextMode::ReadOnly, "prod", "prod").unwrap();
        assert_eq!(
            r,
            "prod is read-only: changes to this cluster are turned off"
        );
    }

    #[test]
    fn protected_needs_the_exact_name() {
        assert_eq!(refusal(ContextMode::Protected, "prod", "prod"), None);
        let missing = refusal(ContextMode::Protected, "prod", "").unwrap();
        assert!(missing.contains("type the context name"), "{missing}");
        for wrong in ["Prod", "prod ", " prod", "pro", "dev"] {
            let r = refusal(ContextMode::Protected, "prod", wrong).unwrap();
            assert!(r.contains("does not match"), "{wrong}: {r}");
        }
        // A context without a name can never be confirmed.
        assert!(refusal(ContextMode::Protected, "", "").is_some());
    }

    #[test]
    fn unknown_modes_read_as_read_only() {
        let read = |s: &str| serde_json::from_str::<ContextMode>(s).unwrap();
        assert_eq!(read(r#""normal""#), ContextMode::Normal);
        assert_eq!(read("null"), ContextMode::Normal);
        assert_eq!(read(r#""readOnly""#), ContextMode::ReadOnly);
        assert_eq!(read(r#""protected""#), ContextMode::Protected);
        assert_eq!(read(r#""readonly""#), ContextMode::ReadOnly);
        assert_eq!(read(r#""locked""#), ContextMode::ReadOnly);
        assert_eq!(read("true"), ContextMode::ReadOnly);
        assert_eq!(
            serde_json::to_string(&ContextMode::ReadOnly).unwrap(),
            r#""readOnly""#
        );
    }

    #[test]
    fn logs_and_port_forwards_do_not_mutate() {
        assert!(!action_mutates("logs"));
        assert!(!action_mutates("portForward"));
        for id in [
            "delete",
            "scale",
            "shell",
            "attach",
            "edit",
            "nodeShell",
            "debug",
        ] {
            assert!(action_mutates(id), "{id}");
        }
    }

    #[test]
    fn read_only_overrides_rbac_for_changes_only() {
        use crate::action_access::ActionAccess;
        let a = |id: &str, allowed: bool, reason: &str| ActionAccess {
            id: id.into(),
            allowed,
            reason: reason.into(),
        };
        let rbac = vec![
            a("logs", true, ""),
            a("delete", true, ""),
            a("scale", false, "Not allowed: you can't patch"),
            a("portForward", false, "Not allowed: you can't create"),
        ];
        assert_eq!(
            apply_to_access(ContextMode::Protected, "prod", rbac.clone()),
            rbac
        );
        let ro = apply_to_access(ContextMode::ReadOnly, "prod", rbac);
        let reason = read_only_reason("prod");
        assert_eq!(
            ro,
            vec![
                a("logs", true, ""),
                a("delete", false, &reason),
                a("scale", false, &reason),
                a("portForward", false, "Not allowed: you can't create"),
            ]
        );
    }

    #[test]
    fn the_cli_finds_every_id_the_app_may_give_a_context() {
        use crate::catalog::CatalogInput;
        let dir = std::env::temp_dir().join(format!("nauvi-338-ids-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kc = |ctx: &str| {
            format!(
                "apiVersion: v1\nkind: Config\ncurrent-context: {ctx}\nclusters:\n- name: c\n  cluster: {{server: 'https://127.0.0.1:1'}}\nusers:\n- name: u\n  user: {{token: t}}\ncontexts:\n- name: {ctx}\n  context: {{cluster: c, user: u}}\n"
            )
        };
        let default = dir.join("config");
        let work = dir.join("work.yaml");
        let other = dir.join("other.yaml");
        for f in [&default, &work, &other] {
            std::fs::write(f, kc("prod")).unwrap();
        }
        let input = |defaults: Vec<PathBuf>| CatalogInput {
            default_paths: defaults,
            extra: vec![work.clone()],
            pasted_dir: None,
        };
        // The app's catalog: its default kubeconfig first, then work.yaml.
        let app = [input(vec![default.clone()])];
        assert_eq!(
            ids_in_catalogs(&app, std::slice::from_ref(&default), "prod"),
            ["prod"]
        );
        let work_ids = ids_in_catalogs(&app, std::slice::from_ref(&work), "prod");
        assert_eq!(work_ids.len(), 1);
        assert_ne!(
            work_ids[0], "prod",
            "the added file's context has its own id"
        );
        // The same file through another path.
        let dotted = dir.join(".").join("work.yaml");
        assert_eq!(ids_in_catalogs(&app, &[dotted], "prod"), work_ids);
        // KUBECONFIG = the added file: the CLI's catalog reads it as the
        // default one ("prod"), the app's as "prod (work.yaml)". Both count.
        let cli = [input(vec![work.clone()]), input(vec![default.clone()])];
        let both = ids_in_catalogs(&cli, std::slice::from_ref(&work), "prod");
        assert_eq!(both, ["prod".to_string(), work_ids[0].clone()]);
        let text = format!(
            r#"{{"contexts":{{"prod":{{"mode":"normal"}},"{}":{{"mode":"protected"}}}}}}"#,
            work_ids[0]
        );
        assert_eq!(
            mode_of_ids(&text, &both, Some(&work), "prod"),
            CliMode::Known(ContextMode::Protected)
        );
        // A file or context the app does not have.
        assert!(ids_in_catalogs(&app, &[other], "prod").is_empty());
        assert!(ids_in_catalogs(&app, std::slice::from_ref(&default), "dev").is_empty());
        assert!(matches!(
            mode_of_ids(&text, &[], None, "dev"),
            CliMode::Unknown(_)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stored modes are matched by what their ids mean (#338 re-check): the
    /// app may name a file's context differently from the CLI.
    #[test]
    fn stored_modes_are_matched_by_file_and_context() {
        use crate::catalog::CatalogInput;
        let dir = std::env::temp_dir().join(format!("nauvi-338-meaning-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kc = |ctx: &str| {
            format!(
                "apiVersion: v1\nkind: Config\ncurrent-context: {ctx}\nclusters:\n- name: c\n  cluster: {{server: 'https://127.0.0.1:1'}}\nusers:\n- name: u\n  user: {{token: t}}\ncontexts:\n- name: {ctx}\n  context: {{cluster: c, user: u}}\n"
            )
        };
        // The app runs with its own KUBECONFIG, a.yaml, which the CLI
        // never sees; work.yaml is added in the app.
        let a = dir.join("a.yaml");
        let work = dir.join("work.yaml");
        let other = dir.join("other.yaml");
        for f in [&a, &work, &other] {
            std::fs::write(f, kc("prod")).unwrap();
        }
        let app = crate::catalog::load_catalog(&CatalogInput {
            default_paths: vec![a.clone()],
            extra: vec![work.clone(), other.clone()],
            pasted_dir: None,
        });
        let work_id = app
            .contexts
            .iter()
            .find(|c| Path::new(&c.file) == work)
            .unwrap()
            .name
            .clone();
        assert_eq!(work_id, "prod (work.yaml)");
        // What the CLI sees: the added files, not a.yaml.
        let cli = [CatalogInput {
            default_paths: vec![],
            extra: vec![work.clone(), other.clone()],
            pasted_dir: None,
        }];
        let known = known_contexts(&cli);
        let files = [work.clone()];
        let ids = ids_in_catalogs(&cli, &files, "prod");
        assert_eq!(ids, ["prod"], "the CLI names it differently");
        let mode = |text: &str| mode_by_meaning(text, &ids, Some(&work), "prod", &files, &known);
        let protected =
            r#"{"contexts":{"prod":{"mode":"normal"},"prod (work.yaml)":{"mode":"protected"}}}"#;
        assert_eq!(mode(protected), CliMode::Known(ContextMode::Protected));
        // `name (path)` and `name (path) #n`.
        let path_id = format!("prod ({})", work.display());
        let numbered = format!("prod ({}) #3", work.display());
        for id in [&path_id, &numbered] {
            let text = serde_json::json!({ "contexts": { id.as_str(): { "mode": "readOnly" } } })
                .to_string();
            assert_eq!(mode(&text), CliMode::Known(ContextMode::ReadOnly), "{id}");
        }
        // Another file's entry does not count; an unresolvable one does.
        let other_id = format!("prod ({}) #2", other.display());
        let text = serde_json::json!({ "contexts": {
            "prod (other.yaml)": { "mode": "readOnly" },
            other_id.as_str(): { "mode": "readOnly" },
            "dev": { "mode": "readOnly" },
        } })
        .to_string();
        assert_eq!(mode(&text), CliMode::Known(ContextMode::Normal));
        let gone = r#"{"contexts":{"prod (gone.yaml)":{"mode":"protected"},"prod (/nowhere/x.yaml) #2":{"mode":"readOnly"}}}"#;
        assert_eq!(mode(gone), CliMode::Known(ContextMode::ReadOnly));
        // A file the CLI's catalogs lack: unknown, unless a stored entry
        // may name it.
        let stray = dir.join("stray.yaml");
        std::fs::write(&stray, kc("prod")).unwrap();
        let sf = [stray.clone()];
        let none = ids_in_catalogs(&cli, &sf, "prod");
        assert!(none.is_empty());
        let stray_mode =
            |text: &str| mode_by_meaning(text, &none, Some(&stray), "prod", &sf, &known);
        assert!(matches!(
            stray_mode(r#"{"contexts":{}}"#),
            CliMode::Unknown(_)
        ));
        let stray_id = format!("prod ({})", stray.display());
        let text =
            serde_json::json!({ "contexts": { stray_id.as_str(): { "mode": "protected" } } })
                .to_string();
        assert_eq!(stray_mode(&text), CliMode::Known(ContextMode::Protected));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_strictest_mode_wins() {
        use ContextMode::*;
        assert_eq!(strictest([Normal, Protected, Normal]), Protected);
        assert_eq!(strictest([Protected, ReadOnly]), ReadOnly);
        assert_eq!(strictest([Normal]), Normal);
        assert_eq!(strictest([]), Normal);
    }

    #[test]
    fn the_mode_is_read_from_the_app_settings() {
        let text = r#"{"contexts":{"prod":{"mode":"protected"},"ro":{"mode":"readOnly"},
            "dev":{"view":"overview"},"odd":{"mode":"bogus"}}}"#;
        assert_eq!(mode_in_settings_text(text, "prod"), ContextMode::Protected);
        assert_eq!(mode_in_settings_text(text, "ro"), ContextMode::ReadOnly);
        assert_eq!(mode_in_settings_text(text, "dev"), ContextMode::Normal);
        assert_eq!(mode_in_settings_text(text, "missing"), ContextMode::Normal);
        assert_eq!(mode_in_settings_text(text, "odd"), ContextMode::ReadOnly);
        assert_eq!(
            mode_in_settings_text("{not json", "prod"),
            ContextMode::ReadOnly
        );
        let missing = std::env::temp_dir().join("nauvi-338-no-such-settings.json");
        assert_eq!(mode_in_settings(&missing, "prod"), ContextMode::Normal);
    }
}
