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

/// The app's catalog id of `context` from `kubeconfig` (`None`: the default
/// kubeconfig), in a catalog built from the app's added `sources` exactly as
/// the app builds it ([`crate::catalog::load_catalog`]). The id is the
/// context's name unless an earlier source has one of that name, e.g.
/// `prod (work.yaml)`.
pub fn app_context_id(
    sources: &[PathBuf],
    pasted_dir: Option<PathBuf>,
    kubeconfig: Option<&Path>,
    context: &str,
) -> Option<String> {
    use crate::catalog::{load_catalog, CatalogInput};
    let catalog = load_catalog(&CatalogInput::here(sources.to_vec(), pasted_dir));
    id_in_catalog(&catalog, kubeconfig, context)
}

/// [`app_context_id`] in a catalog already built.
fn id_in_catalog(
    catalog: &crate::catalog::Catalog,
    kubeconfig: Option<&Path>,
    context: &str,
) -> Option<String> {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let wanted = kubeconfig.map(canon);
    catalog
        .contexts
        .iter()
        .find(|c| {
            c.context == context
                && match &wanted {
                    None => c.source.is_empty(),
                    Some(file) => canon(Path::new(&c.file)) == *file,
                }
        })
        .map(|c| c.name.clone())
}

/// The mode of `context` from `kubeconfig` in the app's settings at
/// `settings_path`, keyed by the context's catalog id ([`app_context_id`]).
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
    match app_context_id(&sources, pasted, kubeconfig, context) {
        Some(id) => CliMode::Known(mode_in_settings_text(&text, &id)),
        None => CliMode::Unknown(format!(
            "context {context}{} is not in nauvi's cluster catalog, so its read-only or \
             protected setting cannot be checked",
            kubeconfig
                .map(|p| format!(" of {}", p.display()))
                .unwrap_or_default()
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
    fn the_cli_finds_the_id_the_app_gives_a_context() {
        use crate::catalog::{load_catalog, CatalogInput};
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
        std::fs::write(&default, kc("prod")).unwrap();
        std::fs::write(&work, kc("prod")).unwrap();
        std::fs::write(&other, kc("prod")).unwrap();
        let catalog = load_catalog(&CatalogInput {
            default_paths: vec![default.clone()],
            extra: vec![work.clone()],
            pasted_dir: None,
        });
        assert_eq!(
            id_in_catalog(&catalog, None, "prod").as_deref(),
            Some("prod")
        );
        assert_eq!(
            id_in_catalog(&catalog, Some(&default), "prod").as_deref(),
            Some("prod")
        );
        let id = id_in_catalog(&catalog, Some(&work), "prod").unwrap();
        assert_ne!(id, "prod", "the added file's context has its own id");
        assert_eq!(catalog.find(&id).unwrap().file, work.display().to_string());
        // The same file through another path.
        let dotted = dir.join(".").join("work.yaml");
        assert_eq!(id_in_catalog(&catalog, Some(&dotted), "prod"), Some(id));
        // A file or context the app does not have.
        assert_eq!(id_in_catalog(&catalog, Some(&other), "prod"), None);
        assert_eq!(id_in_catalog(&catalog, None, "dev"), None);
        let _ = std::fs::remove_dir_all(&dir);
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
