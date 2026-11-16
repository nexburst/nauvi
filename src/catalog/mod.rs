//! The cluster catalog (#78): every context from the default kubeconfig
//! (`KUBECONFIG`, else `~/.kube/config`) and from extra kubeconfig files and
//! folders the user added, with a unique id each.
//!
//! The default files are merged the way kubectl merges them, and their
//! contexts keep their names as ids. Each extra file stands on its own: its
//! contexts connect with that file only. A context whose name is already
//! taken gets the id `name (file name)` (or `name (full path)`), so the id
//! can key settings, windows and the palette.
//!
//! Nothing here writes a kubeconfig file the user owns; pasted kubeconfigs
//! are saved in the app's own directory (see [`save_pasted_kubeconfig`]).

mod check;
mod files;
mod flat;
mod local_files;

pub use check::*;
pub use files::*;
pub use flat::*;
pub use local_files::*;

use anyhow::{anyhow, Result};
use kube::config::Kubeconfig;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Where a source of contexts comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// A file of the default kubeconfig (`KUBECONFIG` or `~/.kube/config`).
    Kubeconfig,
    /// A kubeconfig file the user added.
    File,
    /// A folder the user added: every kubeconfig file in it.
    Folder,
    /// A kubeconfig pasted into the app, saved in its config directory.
    Pasted,
}

/// One source of contexts, for the catalog's list of sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SourceInfo {
    pub path: String,
    pub kind: SourceKind,
    /// Contexts it brought in (duplicates of earlier sources included).
    pub contexts: u32,
    /// Kubeconfig files read (a folder may hold several).
    pub files: u32,
    /// Why it could not be read (`""`: it was read).
    pub error: String,
}

/// A context in the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ContextInfo {
    /// The context's id: its name, or `name (file)` when an earlier source
    /// already has a context of that name. Commands take this id.
    pub name: String,
    /// The context's name in its kubeconfig file.
    pub context: String,
    pub current: bool,
    /// The context's default namespace (`contexts[].context.namespace`).
    pub namespace: Option<String>,
    /// Its cluster's and user's names in the file, and the API server.
    pub cluster: String,
    pub user: String,
    pub server: String,
    /// The file that defines it.
    pub file: String,
    /// The added source it came from (a file, folder or pasted file);
    /// `""` for the default kubeconfig.
    pub source: String,
    /// The command logging in runs: the exec plugin's command and
    /// arguments, or the gcp auth provider's `cmd-path` (`""`: none).
    pub login_command: String,
    /// Logging in runs a plugin or an auth provider (`exec` or
    /// `auth-provider`): the catalog checks it only when asked (#201).
    pub login_plugin: bool,
    /// The `tokenFile`, `client-certificate` and `client-key` paths of an
    /// added file's context outside that file's folder: logging in sends
    /// them, so the catalog checks it only when asked (#244). `[]` for the
    /// default kubeconfig.
    pub local_files: Vec<String>,
}

/// What to connect to for a context id: its name in its kubeconfig and
/// the file to read (`None`: the default kubeconfig, as kubectl reads it).
/// Helm and local shells get the same file and context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextTarget {
    pub id: String,
    pub context: String,
    pub kubeconfig: Option<PathBuf>,
}

/// What the catalog is built from.
#[derive(Debug, Clone, Default)]
pub struct CatalogInput {
    /// The default kubeconfig files, merged in order.
    pub default_paths: Vec<PathBuf>,
    /// The added files and folders (pasted files included), in order.
    pub extra: Vec<PathBuf>,
    /// Where pasted kubeconfigs are saved: sources inside it are `Pasted`.
    pub pasted_dir: Option<PathBuf>,
}

impl CatalogInput {
    /// The default kubeconfig of this process plus `extra`.
    pub fn here(extra: Vec<PathBuf>, pasted_dir: Option<PathBuf>) -> Self {
        Self {
            default_paths: default_kubeconfig_paths(),
            extra,
            pasted_dir,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub contexts: Vec<ContextInfo>,
    pub sources: Vec<SourceInfo>,
    /// The default kubeconfig's current-context (`""`: none).
    pub current_context: String,
}

impl Catalog {
    pub fn find(&self, id: &str) -> Option<&ContextInfo> {
        self.contexts.iter().find(|c| c.name == id)
    }

    /// The target of context `id` (`None`: the default kubeconfig's
    /// current-context).
    pub fn resolve(&self, id: Option<&str>) -> Result<ContextTarget> {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            if self.current_context.is_empty() {
                return Err(anyhow!("the kubeconfig has no current context"));
            }
            return Ok(ContextTarget {
                id: self.current_context.clone(),
                context: self.current_context.clone(),
                kubeconfig: None,
            });
        };
        let ctx = self.find(id).ok_or_else(|| {
            anyhow!("context `{id}` is not in the kubeconfig or in any added kubeconfig file")
        })?;
        Ok(ContextTarget {
            id: ctx.name.clone(),
            context: ctx.context.clone(),
            kubeconfig: (!ctx.source.is_empty()).then(|| PathBuf::from(&ctx.file)),
        })
    }
}

/// Build the catalog. Never fails: what cannot be read is reported in its
/// source's `error`.
pub fn load_catalog(input: &CatalogInput) -> Catalog {
    let mut catalog = Catalog::default();
    let mut used: HashSet<String> = HashSet::new();
    // Files already read, so a file added twice (or the default one added
    // again) does not show its contexts twice.
    let mut seen: HashSet<PathBuf> = HashSet::new();

    add_default(&mut catalog, &mut used, &mut seen, &input.default_paths);

    for source in &input.extra {
        let pasted = input
            .pasted_dir
            .as_deref()
            .is_some_and(|dir| source.parent() == Some(dir));
        let (kind, files, error) = if source.is_dir() {
            match folder_files(source) {
                Ok(files) => (SourceKind::Folder, files, String::new()),
                Err(e) => (
                    SourceKind::Folder,
                    vec![],
                    format!("cannot read the folder: {e}"),
                ),
            }
        } else {
            let kind = if pasted {
                SourceKind::Pasted
            } else {
                SourceKind::File
            };
            (kind, vec![source.clone()], String::new())
        };
        let mut info = SourceInfo {
            path: source.display().to_string(),
            kind,
            contexts: 0,
            files: 0,
            error,
        };
        for file in files {
            if !seen.insert(canonical(&file)) {
                continue;
            }
            let kc = match Kubeconfig::read_from(&file) {
                Ok(kc) => kc,
                // A folder may hold other files: skip what is not a kubeconfig.
                Err(_) if kind == SourceKind::Folder => continue,
                Err(e) => {
                    info.error = read_error(&e);
                    continue;
                }
            };
            if kind == SourceKind::Folder && kc.contexts.is_empty() {
                continue;
            }
            info.files += 1;
            for named in &kc.contexts {
                info.contexts += 1;
                let id = unique_id(&mut used, &named.name, &file);
                catalog
                    .contexts
                    .push(context_info(&kc, &named.name, id, &file, source));
            }
        }
        catalog.sources.push(info);
    }
    catalog
}

/// The default kubeconfig's contexts: the files merged (first wins), each
/// context attributed to the first file that defines it.
fn add_default(
    catalog: &mut Catalog,
    used: &mut HashSet<String>,
    seen: &mut HashSet<PathBuf>,
    paths: &[PathBuf],
) {
    let mut merged = Kubeconfig::default();
    let mut owner: Vec<(String, PathBuf)> = Vec::new();
    for path in paths {
        seen.insert(canonical(path));
        let mut info = SourceInfo {
            path: path.display().to_string(),
            kind: SourceKind::Kubeconfig,
            contexts: 0,
            files: 0,
            error: String::new(),
        };
        if !path.exists() {
            info.error = "the file does not exist".to_string();
            catalog.sources.push(info);
            continue;
        }
        match Kubeconfig::read_from(path) {
            Ok(kc) => {
                info.files = 1;
                info.contexts = kc.contexts.len() as u32;
                for c in &kc.contexts {
                    if !owner.iter().any(|(n, _)| n == &c.name) {
                        owner.push((c.name.clone(), path.clone()));
                    }
                }
                match merged.clone().merge(kc) {
                    Ok(m) => merged = m,
                    Err(e) => info.error = read_error(&e),
                }
            }
            Err(e) => info.error = read_error(&e),
        }
        catalog.sources.push(info);
    }
    catalog.current_context = merged.current_context.clone().unwrap_or_default();
    for (name, file) in owner {
        used.insert(name.clone());
        let mut info = context_info(&merged, &name, name.clone(), &file, Path::new(""));
        info.current = name == catalog.current_context;
        catalog.contexts.push(info);
    }
}

fn context_info(
    kc: &Kubeconfig,
    name: &str,
    id: String,
    file: &Path,
    source: &Path,
) -> ContextInfo {
    let ctx = kc
        .contexts
        .iter()
        .find(|c| c.name == name)
        .and_then(|c| c.context.as_ref());
    let cluster = ctx.map(|c| c.cluster.clone()).unwrap_or_default();
    let server = kc
        .clusters
        .iter()
        .find(|c| c.name == cluster)
        .and_then(|c| c.cluster.as_ref())
        .and_then(|c| c.server.clone())
        .unwrap_or_default();
    let user = ctx.and_then(|c| c.user.clone()).unwrap_or_default();
    let auth = kc
        .auth_infos
        .iter()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.as_ref());
    let (login_command, login_plugin) = match auth {
        Some(a) => (
            login_command(a),
            a.exec.is_some() || a.auth_provider.is_some(),
        ),
        None => (String::new(), false),
    };
    let local_files = match auth {
        Some(a) if !source.as_os_str().is_empty() => {
            local_files_outside(a, file.parent().unwrap_or(Path::new("")))
        }
        _ => vec![],
    };
    ContextInfo {
        name: id,
        context: name.to_string(),
        current: false,
        namespace: ctx.and_then(|c| c.namespace.clone()),
        cluster,
        user,
        server,
        file: file.display().to_string(),
        source: source.display().to_string(),
        login_command,
        login_plugin,
        local_files,
    }
}

/// The command line logging in as `auth` runs (`""`: none), as it is
/// shown before it may run: the exec plugin's, or the gcp auth provider's.
///
/// An exec plugin's `env` is part of it (`env A=1 B=2 aws …`, names
/// sorted, values quoted): it can change what runs (`PATH`, `LD_PRELOAD`),
/// so the user sees it, and a changed env is a new command to allow (#201).
pub fn login_command(auth: &kube::config::AuthInfo) -> String {
    let mut prefix: Vec<String> = Vec::new();
    let (command, args) = if let Some(exec) = &auth.exec {
        let mut env: Vec<(&String, &String)> = exec
            .env
            .iter()
            .flatten()
            .filter_map(|e| Some((e.get("name")?, e.get("value")?)))
            .collect();
        // Stable: of two entries with one name, the last one still wins.
        env.sort_by(|a, b| a.0.cmp(b.0));
        if !env.is_empty() {
            prefix.push("env".to_string());
            prefix.extend(
                env.into_iter()
                    .map(|(name, value)| format!("{}={}", shell_word(name), shell_word(value))),
            );
        }
        (
            exec.command.clone().unwrap_or_default(),
            exec.args.clone().unwrap_or_default(),
        )
    } else if let Some(p) = auth.auth_provider.as_ref().filter(|p| p.name == "gcp") {
        let Some(path) = p.config.get("cmd-path") else {
            return String::new();
        };
        let args = p
            .config
            .get("cmd-args")
            .map(|a| a.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        (path.clone(), args)
    } else {
        return String::new();
    };
    prefix
        .into_iter()
        .chain(std::iter::once(command).chain(args).map(|a| shell_word(&a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `word` quoted for a shell if it needs it, so the command shown is exact.
///
/// Control and format characters (newlines, bidi overrides, zero-width
/// characters, …) are written as visible escapes in bash's `$'…'` form, so
/// they cannot hide or reorder the rest of the command in the prompt (#201).
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=,@%+".contains(c));
    if plain {
        return word.to_string();
    }
    if !word.chars().any(is_invisible) {
        return format!("'{}'", word.replace('\'', r"'\''"));
    }
    let mut out = String::from("$'");
    for c in word.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '\'' => out.push_str(r"\'"),
            '\n' => out.push_str(r"\n"),
            '\t' => out.push_str(r"\t"),
            '\r' => out.push_str(r"\r"),
            c if is_invisible(c) && (c as u32) <= 0xffff => {
                out.push_str(&format!(r"\u{:04x}", c as u32))
            }
            c if is_invisible(c) => out.push_str(&format!(r"\U{:08x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Control (Cc), format (Cf) and line/paragraph separator characters:
/// those that show as nothing, move text or reorder it.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F)
}

/// A unique id for context `name` from `file`: the name if it is free,
/// else `name (file name)`, else `name (full path)`, else numbered.
pub fn unique_id(used: &mut HashSet<String>, name: &str, file: &Path) -> String {
    let file_name = file
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut candidates = vec![name.to_string()];
    if !file_name.is_empty() {
        candidates.push(format!("{name} ({file_name})"));
    }
    candidates.push(format!("{name} ({})", file.display()));
    let id = candidates
        .into_iter()
        .find(|c| !used.contains(c))
        .unwrap_or_else(|| {
            (2..)
                .map(|n| format!("{name} ({}) #{n}", file.display()))
                .find(|c| !used.contains(c))
                .expect("some number is free")
        });
    used.insert(id.clone());
    id
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_error(e: &kube::config::KubeconfigError) -> String {
    crate::errors::kubeconfig_error_text(e, None)
}

/// The contexts of the default kubeconfig, and which one is current.
pub async fn list_contexts() -> Result<Vec<ContextInfo>> {
    let catalog = load_catalog(&CatalogInput::here(vec![], None));
    if catalog.contexts.is_empty() {
        // As before: no kubeconfig at all is an error.
        Kubeconfig::read().map_err(|e| {
            anyhow::anyhow!(crate::client::kubeconfig_read_message(
                &e,
                std::env::var_os("KUBECONFIG").as_deref(),
                home::home_dir().as_deref(),
            ))
        })?;
    }
    Ok(catalog.contexts)
}

#[cfg(test)]
mod tests;
