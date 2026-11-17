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

/// Where a mode was set: the kubeconfig file the context came from and its
/// name in that file (#338). The app stores it with the mode, so the CLI
/// matches a mode by (file, context) instead of by the app's context id,
/// whose form depends on the app's own kubeconfig.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct ModeSource {
    /// The file, canonical (symlinks resolved).
    pub file: String,
    /// The file as the app's catalog names it.
    pub given: String,
    /// The context's name in that file.
    pub context: String,
}

impl ModeSource {
    /// The source of `context` read from `file`.
    pub fn new(file: &Path, context: &str) -> Self {
        Self {
            file: canonical(file).display().to_string(),
            given: file.display().to_string(),
            context: context.to_string(),
        }
    }
}

/// The files the CLI reads `context` from (`--kubeconfig`, else the default
/// kubeconfig's files), canonical.
fn cli_files(kubeconfig: Option<&Path>) -> Vec<PathBuf> {
    match kubeconfig {
        Some(p) => vec![canonical(p)],
        None => crate::catalog::default_kubeconfig_paths()
            .iter()
            .map(|p| canonical(p))
            .collect(),
    }
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Whether the app's catalog has `context` from one of `files`: a catalog
/// built from the app's added `sources` as the app builds it, with the
/// CLI's default kubeconfig, with `~/.kube/config` and with none (the
/// CLI cannot see the app's own default kubeconfig).
fn app_has(
    sources: &[PathBuf],
    pasted_dir: Option<PathBuf>,
    files: &[PathBuf],
    context: &str,
) -> bool {
    use crate::catalog::{default_kubeconfig_paths, load_catalog, CatalogInput};
    let input = |default_paths: Vec<PathBuf>| CatalogInput {
        default_paths,
        extra: sources.to_vec(),
        pasted_dir: pasted_dir.clone(),
    };
    let mut inputs = vec![input(default_kubeconfig_paths()), input(Vec::new())];
    if let Some(home) = home::home_dir() {
        inputs.push(input(vec![home.join(".kube").join("config")]));
    }
    inputs.iter().any(|i| {
        load_catalog(i)
            .contexts
            .iter()
            .any(|c| c.context == context && files.contains(&canonical(Path::new(&c.file))))
    })
}

/// The modes stored for `context` from one of `files` (canonical): every
/// entry whose [`ModeSource`] has that context name and that file
/// (canonical, or its given path resolved now). An entry without a source
/// (none should exist) counts for every context of its name: its id is
/// the name, or the name followed by ` (`.
fn stored_modes(text: &str, context: &str, files: &[PathBuf]) -> Vec<ContextMode> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![ContextMode::ReadOnly];
    };
    let Some(entries) = v.get("contexts").and_then(|c| c.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (id, entry) in entries {
        let Some(m) = entry.get("mode") else { continue };
        let mode = serde_json::from_value(m.clone()).unwrap_or(ContextMode::ReadOnly);
        let source: ModeSource = entry
            .get("mode_source")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();
        let matches = if source.file.is_empty() && source.given.is_empty() {
            id == context || id.starts_with(&format!("{context} ("))
        } else {
            let paths: Vec<&Path> = [&source.file, &source.given]
                .iter()
                .filter(|f| !f.is_empty())
                .map(|f| Path::new(f.as_str()))
                .collect();
            // Neither stored path exists any more (the file was moved or
            // renamed): match by context name alone, to be strict.
            let gone = paths.iter().all(|p| !p.exists());
            source.context == context
                && (gone || paths.iter().any(|p| files.contains(&canonical(p))))
        };
        if matches {
            out.push(mode);
        }
    }
    out
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
/// `settings_path`: the strictest of the modes stored for that context of
/// that file ([`stored_modes`]). No settings file: normal (the app never
/// marked anything). A file that cannot be read: read-only. No stored
/// mode and a context the app's catalog does not have:
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
    let files = cli_files(kubeconfig);
    let stored = stored_modes(&text, context, &files);
    if !stored.is_empty() {
        return CliMode::Known(strictest(stored));
    }
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
    if app_has(&sources, pasted, &files, context) {
        CliMode::Known(ContextMode::Normal)
    } else {
        CliMode::Unknown(format!(
            "context {context}{} is not in nauvi's cluster catalog, so its read-only or \
             protected setting cannot be checked",
            kubeconfig
                .map(|p| format!(" of {}", p.display()))
                .unwrap_or_default()
        ))
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

    /// A settings file with these `(id, mode, source file, context)` entries.
    fn settings(entries: &[(&str, &str, Option<&Path>, &str)]) -> String {
        let mut contexts = serde_json::Map::new();
        for (id, mode, file, ctx) in entries {
            let mut e = serde_json::json!({ "mode": mode });
            if let Some(f) = file {
                e["mode_source"] = serde_json::to_value(ModeSource::new(f, ctx)).unwrap();
            }
            contexts.insert(id.to_string(), e);
        }
        serde_json::json!({ "contexts": contexts }).to_string()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nauvi-338-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Modes are matched by (canonical file, context name), whatever id the
    /// app gave the context (security re-check of #338).
    #[test]
    fn stored_modes_are_matched_by_file_and_context() {
        let dir = temp_dir("modes");
        let work = dir.join("work.yaml");
        let other = dir.join("other.yaml");
        std::fs::write(&work, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let canon = |p: &Path| canonical(p);
        let files = [canon(&work)];
        // The app ran with its own KUBECONFIG, so it called work.yaml's
        // `prod` "prod (work.yaml)"; the CLI only knows it as `prod`.
        let text = settings(&[
            ("prod", "normal", Some(&other), "prod"),
            ("prod (work.yaml)", "protected", Some(&work), "prod"),
        ]);
        assert_eq!(
            stored_modes(&text, "prod", &files),
            [ContextMode::Protected]
        );
        assert_eq!(
            strictest(stored_modes(&text, "prod", &[canon(&other)])),
            ContextMode::Normal
        );
        // `name (path) #n`: the id does not matter.
        let id = format!("prod ({}) #3", work.display());
        let text = settings(&[(&id, "readOnly", Some(&work), "prod")]);
        assert_eq!(stored_modes(&text, "prod", &files), [ContextMode::ReadOnly]);
        // Context names with " (" and "#" are compared whole.
        let odd = "prod (eu) #2";
        let text = settings(&[(odd, "readOnly", Some(&work), odd)]);
        assert_eq!(stored_modes(&text, odd, &files), [ContextMode::ReadOnly]);
        assert!(stored_modes(&text, "prod", &files).is_empty());
        assert!(stored_modes(&text, "prod (eu)", &files).is_empty());
        // Another context of the same file does not count.
        assert!(stored_modes(&text, "dev", &files).is_empty());
        // The strictest of several entries for the same file and context.
        let text = settings(&[
            ("prod", "protected", Some(&work), "prod"),
            ("prod (work.yaml)", "readOnly", Some(&work), "prod"),
        ]);
        assert_eq!(
            strictest(stored_modes(&text, "prod", &files)),
            ContextMode::ReadOnly
        );
        // An entry without a source counts for every context of its name.
        let text = settings(&[("prod (somewhere)", "protected", None, "")]);
        assert_eq!(
            stored_modes(&text, "prod", &files),
            [ContextMode::Protected]
        );
        assert!(stored_modes(&text, "dev", &files).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_moved_kubeconfig_keeps_its_mode() {
        let dir = temp_dir("moved");
        let old = dir.join("work.yaml");
        let new = dir.join("moved").join("prod.yaml");
        std::fs::write(&old, "x").unwrap();
        let text = settings(&[("prod (work.yaml)", "protected", Some(&old), "prod")]);
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        std::fs::rename(&old, &new).unwrap();
        // Neither stored path exists: matched by context name alone.
        assert_eq!(
            stored_modes(&text, "prod", &cli_files(Some(&new))),
            [ContextMode::Protected]
        );
        assert!(stored_modes(&text, "dev", &cli_files(Some(&new))).is_empty());
        // While the stored file exists, another file does not match.
        let back = dir.join("work.yaml");
        std::fs::write(&back, "x").unwrap();
        assert!(stored_modes(&text, "prod", &cli_files(Some(&new))).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_files_with_the_same_name_are_told_apart() {
        let dir = temp_dir("samename");
        let a = dir.join("a").join("work.yaml");
        let b = dir.join("b").join("work.yaml");
        for f in [&a, &b] {
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
        let text = settings(&[("prod (work.yaml)", "readOnly", Some(&a), "prod")]);
        assert_eq!(
            stored_modes(&text, "prod", &[canonical(&a)]),
            [ContextMode::ReadOnly]
        );
        assert!(stored_modes(&text, "prod", &[canonical(&b)]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_kubeconfig_matches_its_target() {
        let dir = temp_dir("symlink");
        let target = dir.join("cfg.yaml");
        let link = dir.join("kc").join("work.yaml");
        std::fs::write(&target, "x").unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        // The app added the link; the CLI reads the link, or the target.
        let text = settings(&[("prod (work.yaml)", "protected", Some(&link), "prod")]);
        assert_eq!(cli_files(Some(&link)), [canonical(&target)]);
        assert_eq!(
            stored_modes(&text, "prod", &cli_files(Some(&link))),
            [ContextMode::Protected]
        );
        assert_eq!(
            stored_modes(&text, "prod", &cli_files(Some(&target))),
            [ContextMode::Protected]
        );
        // Saved with the target, read through the link.
        let text = settings(&[("prod", "readOnly", Some(&target), "prod")]);
        assert_eq!(
            stored_modes(&text, "prod", &cli_files(Some(&link))),
            [ContextMode::ReadOnly]
        );
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
