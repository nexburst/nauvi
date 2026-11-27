//! What the app remembers across restarts: a typed `Settings` struct saved
//! as JSON in `app_config_dir()/settings.json`.
//!
//! Reading never fails: a missing file gives the defaults, a field that is
//! missing or does not parse keeps its default, unknown fields are ignored,
//! and an unreadable file is set aside as `settings.json.corrupt`. Writes are
//! atomic (temp file + rename) and debounced.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) mod image_security;
pub(crate) use image_security::{ImageSecurityMode, ImageSecuritySettings};

/// The format written now. Bump it and add a step to `migrate` when a field
/// changes meaning or moves.
pub(crate) const SETTINGS_VERSION: u32 = 1;

/// How long to wait for more changes before writing the file.
const WRITE_DELAY: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Theme {
    /// Follow the system's light or dark preference.
    #[default]
    System,
    Dark,
    Light,
}

/// The zone times are shown in (#330): clocks in charts, notifications and
/// the footer, and "Jump to time" in the log viewer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TimeZone {
    #[default]
    Local,
    Utc,
}

/// The height of table rows (#330).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RowHeight {
    #[default]
    Normal,
    Compact,
}

/// Defaults of the log viewer's controls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct LogDefaults {
    /// Lines to start with: a number, or `"all"`.
    pub(crate) tail: String,
    pub(crate) timestamps: bool,
    pub(crate) wrap: bool,
}

impl Default for LogDefaults {
    fn default() -> Self {
        Self {
            tail: "200".into(),
            timestamps: false,
            wrap: false,
        }
    }
}

/// What is remembered per kubeconfig context, by context id (#78), and set
/// on its cluster settings page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct ContextSettings {
    /// The last view: `"overview"` or a kind id (`apps/v1/deployments`).
    pub(crate) view: String,
    /// The selected namespaces (empty: all namespaces).
    pub(crate) namespaces: Vec<String>,
    /// Namespaces typed in by a user who may not list them.
    pub(crate) typed_namespaces: Vec<String>,
    /// The Prometheus Service for usage charts (#47): `""` detects one,
    /// `"off"` turns it off, else `namespace/service:port`.
    pub(crate) prometheus: String,
    /// Shown instead of the context id (`""`: the id).
    pub(crate) display_name: String,
    /// A CSS colour marking the cluster (`""`: none).
    pub(crate) color: String,
    /// The namespace to start in when none is remembered (`""`: all
    /// namespaces if allowed, else the context's own).
    pub(crate) default_namespace: String,
    /// Where local shells start (`""`: the home directory; `~` expands).
    pub(crate) shell_cwd: String,
    /// When a window last connected to it, epoch milliseconds (0: never).
    pub(crate) last_used: u64,
    /// Hide CPU and memory usage for this cluster (#327): no metric
    /// columns, usage charts or overview usage, and the metrics API is not
    /// polled.
    pub(crate) hide_metrics: bool,
    /// Read-only or protected (#338). Changed only through
    /// `cmd_set_context_mode`: a settings patch keeps it, so a window with
    /// an older copy of the settings cannot turn the protection off.
    pub(crate) mode: nauvi::context_mode::ContextMode,
    /// The kubeconfig file and context the mode was set for, which
    /// `nauvi mcp` matches the mode by (#338). Kept with the mode.
    pub(crate) mode_source: nauvi::context_mode::ModeSource,
    /// Image security for this cluster (#534): as the app's setting, on
    /// or off. Optional in TypeScript: the UI reads none as the default.
    #[specta(optional)]
    pub(crate) image_security: ImageSecurityMode,
}

impl Settings {
    /// The read-only or protected mode of the context `id` (#338).
    pub(crate) fn context_mode(&self, id: &str) -> nauvi::context_mode::ContextMode {
        self.contexts.get(id).map(|c| c.mode).unwrap_or_default()
    }

    /// Whether metrics are hidden for the context `id` (#327).
    pub(crate) fn metrics_hidden(&self, id: &str) -> bool {
        self.contexts.get(id).is_some_and(|c| c.hide_metrics)
    }

    /// Whether image security reads reports for the context `id` (#534).
    pub(crate) fn image_security_enabled(&self, id: &str) -> bool {
        let mode = self.contexts.get(id).map(|c| c.image_security);
        mode.unwrap_or_default().enabled(&self.image_security)
    }
}

/// What is remembered per kind (by kind id).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct KindSettings {
    /// The column the table is sorted by (`""`: unsorted).
    pub(crate) sort_key: String,
    pub(crate) sort_desc: bool,
    /// Keys of the columns the user hid.
    pub(crate) hidden: Vec<String>,
    /// Keys of the off-by-default columns the user turned on (#378). Files
    /// from before it have none, so those columns stay off.
    pub(crate) shown: Vec<String>,
    /// Widths in px the user dragged columns to, by column key (#482).
    /// Columns not in it fit their values.
    pub(crate) widths: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct Settings {
    pub(crate) version: u32,
    /// The context to start in (`""`: the kubeconfig's current-context).
    pub(crate) last_context: String,
    pub(crate) theme: Theme,
    pub(crate) logs: LogDefaults,
    /// Check for new releases on start (used by the update check, #30).
    pub(crate) check_updates: bool,
    /// Width of the detail panel in pixels.
    pub(crate) detail_width: u32,
    /// Height of the bottom dock in pixels (`0`: its default).
    pub(crate) dock_height: u32,
    pub(crate) contexts: BTreeMap<String, ContextSettings>,
    pub(crate) kinds: BTreeMap<String, KindSettings>,
    /// The contexts of the extra windows (besides the main one) open when
    /// the app quit, reopened on start (`""`: the kubeconfig's
    /// current-context). Kept up to date by the backend.
    pub(crate) windows: Vec<String>,
    /// Kubeconfig files and folders added in the catalog (#78), pasted
    /// files included. Changed only through the catalog commands.
    pub(crate) kubeconfig_sources: Vec<String>,
    /// Pinned context ids, in order: first in the context selector and the
    /// palette.
    pub(crate) favourites: Vec<String>,
    /// Context ids hidden from the cluster tree, the context selector and
    /// the palette (ADR 0007, "remove = hide"). Only nauvi's own list: the
    /// kubeconfig files are never changed. The catalog shows them again
    /// with Show hidden, and Unhide takes one off the list.
    pub(crate) hidden_contexts: Vec<String>,
    /// The page zoom in percent (#207), within `ZOOM_RANGE`.
    pub(crate) zoom: u32,
    /// The terminal's font size in pixels (#207), within `TERMINAL_FONT_RANGE`.
    pub(crate) terminal_font_size: u32,
    /// The YAML editor's font size in pixels (#330), within `EDITOR_FONT_RANGE`.
    pub(crate) editor_font_size: u32,
    /// The YAML editor's tab size and indent in columns (#330), within
    /// `EDITOR_TAB_RANGE`.
    pub(crate) editor_tab_size: u32,
    pub(crate) time_zone: TimeZone,
    pub(crate) row_height: RowHeight,
    /// Disconnect a cluster the window does not show, that nothing keeps
    /// connected (a port-forward, terminal, log stream or drain), after
    /// this many minutes untouched (ADR 0007). `0`: never. Within
    /// `IDLE_DISCONNECT_RANGE`.
    pub(crate) idle_disconnect_minutes: u32,
    /// Saved port-forwards (#217), by context id. Changed only through the
    /// port-forward commands. Entries that do not parse or whose ports are
    /// invalid are skipped on load, keeping the others.
    #[serde(deserialize_with = "lenient_forwards")]
    #[specta(type = BTreeMap<String, Vec<SavedForward>>)]
    pub(crate) forwards: BTreeMap<String, Vec<SavedForward>>,
    /// The table filter's recent and starred searches (#219), offered in
    /// every list. Only what the user typed in the filter box and its two
    /// toggles: never anything read from the cluster (so no Secret data).
    /// A bad entry is skipped on load, keeping the others.
    #[serde(deserialize_with = "lenient_searches")]
    #[specta(type = SearchHistory)]
    pub(crate) searches: SearchHistory,
    /// Offer a kubectl matching the cluster's version in the local
    /// terminal when the installed one is too far from it (#331). Off by
    /// default; nothing is downloaded without a click.
    pub(crate) kubectl_match: bool,
    /// The sidebar sections the user collapsed (#383), by id (`workloads`,
    /// `network`, `helm`, `custom`...). Empty: every section open.
    pub(crate) collapsed_sections: Vec<String>,
    /// The sidebar sections whose less-used kinds ("More") the user opened
    /// (#481), by the same ids. Empty: only the common kinds show.
    pub(crate) open_more_sections: Vec<String>,
    /// Ask AI's CLI (#376): `claude`, `codex`, `gemini`, `custom`, or `""`
    /// (the first known one found on `PATH`).
    pub(crate) ask_ai_cli: String,
    /// Ask AI's custom command, the program and its arguments (#376). Split
    /// into words, never run through a shell.
    pub(crate) ask_ai_command: String,
    /// The welcome screen (#485) was left once. `false` only in the
    /// settings of a first run (no settings file yet): a file from before
    /// it, or one that had to be reset, counts as welcomed.
    pub(crate) welcomed: bool,
    /// How many more starts show the tips strip (#485): `TIPS_SESSIONS`
    /// on a first run, 0 once it is dismissed or used up (and for a file
    /// from before it).
    pub(crate) tips_left: u32,
    /// Image security (#534): off by default.
    pub(crate) image_security: ImageSecuritySettings,
}

/// The starts that show the tips strip on a first run (#485).
pub(crate) const TIPS_SESSIONS: u32 = 5;

/// `searches` as read from the file: each entry parsed on its own, so one
/// bad entry (or a list that is not a list) does not cost the rest (#219).
fn lenient_searches<'de, D>(d: D) -> Result<SearchHistory, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Value::Object(obj) = Value::deserialize(d)? else {
        return Ok(SearchHistory::default());
    };
    let list = |key: &str| -> Vec<SavedSearch> {
        match obj.get(key) {
            Some(Value::Array(entries)) => entries
                .iter()
                .filter_map(|v| serde_json::from_value::<SavedSearch>(v.clone()).ok())
                .collect(),
            _ => Vec::new(),
        }
    };
    Ok(SearchHistory {
        recent: list("recent"),
        starred: list("starred"),
    }
    .normalized())
}

/// One search of the table filter (#219).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct SavedSearch {
    pub(crate) text: String,
    pub(crate) regex: bool,
    pub(crate) match_case: bool,
}

/// The table filter's search history (#219): the last `MAX_RECENT`
/// searches, newest first, and the starred ones, in the order starred.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct SearchHistory {
    pub(crate) recent: Vec<SavedSearch>,
    pub(crate) starred: Vec<SavedSearch>,
}

/// At most this many recent searches are kept (the UI keeps the same).
pub(crate) const MAX_RECENT: usize = 10;
/// At most this many starred searches are kept.
pub(crate) const MAX_STARRED: usize = 50;
/// Longer searches are not kept.
pub(crate) const MAX_SEARCH_LEN: usize = 200;

impl SearchHistory {
    /// Drop empty, too long and repeated entries and cap both lists, so a
    /// hand-edited or old file cannot grow without bound.
    pub(crate) fn normalized(self) -> Self {
        fn clean(list: Vec<SavedSearch>, max: usize) -> Vec<SavedSearch> {
            let mut out: Vec<SavedSearch> = Vec::new();
            for s in list {
                if s.text.trim().is_empty() || s.text.chars().count() > MAX_SEARCH_LEN {
                    continue;
                }
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            out.truncate(max);
            out
        }
        Self {
            recent: clean(self.recent, MAX_RECENT),
            starred: clean(self.starred, MAX_STARRED),
        }
    }
}

/// A port-forward kept across restarts (#217). Only what is needed to start
/// it again: no credentials, nothing from the cluster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) struct SavedForward {
    /// Stable across restarts (`""` when the UI creates one).
    pub(crate) id: String,
    pub(crate) target: nauvi::ForwardTarget,
    /// The remote port: a number or a port name.
    pub(crate) remote: String,
    /// The local port as typed: `""` automatic, `"0"` any free port, else
    /// that port.
    pub(crate) local_port: String,
    /// The target speaks TLS: its URL is `https://`.
    pub(crate) https: bool,
    /// Open the URL in the browser when the user starts it.
    pub(crate) open_in_browser: bool,
    /// Start it when a window connects to its context (else it comes back
    /// stopped).
    pub(crate) auto_start: bool,
}

/// What `zoom` may be, in percent.
pub(crate) const ZOOM_RANGE: (u32, u32) = (50, 200);
/// What `terminal_font_size` may be, in pixels.
pub(crate) const TERMINAL_FONT_RANGE: (u32, u32) = (8, 32);
/// What `editor_font_size` may be, in pixels.
pub(crate) const EDITOR_FONT_RANGE: (u32, u32) = (8, 32);
/// What `editor_tab_size` may be, in columns.
pub(crate) const EDITOR_TAB_RANGE: (u32, u32) = (1, 8);
/// What `idle_disconnect_minutes` may be (`0`: never), up to a day.
pub(crate) const IDLE_DISCONNECT_RANGE: (u32, u32) = (0, 24 * 60);

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            last_context: String::new(),
            theme: Theme::System,
            logs: LogDefaults::default(),
            check_updates: true,
            detail_width: 420,
            dock_height: 0,
            contexts: BTreeMap::new(),
            kinds: BTreeMap::new(),
            windows: Vec::new(),
            kubeconfig_sources: Vec::new(),
            favourites: Vec::new(),
            hidden_contexts: Vec::new(),
            zoom: 100,
            terminal_font_size: 12,
            editor_font_size: 12,
            editor_tab_size: 2,
            time_zone: TimeZone::Local,
            row_height: RowHeight::Normal,
            idle_disconnect_minutes: 10,
            forwards: BTreeMap::new(),
            searches: SearchHistory::default(),
            kubectl_match: false,
            collapsed_sections: Vec::new(),
            open_more_sections: Vec::new(),
            ask_ai_cli: String::new(),
            ask_ai_command: String::new(),
            welcomed: true,
            tips_left: 0,
            image_security: ImageSecuritySettings::default(),
        }
    }
}

impl Settings {
    /// The settings of a first run (no settings file yet): the welcome
    /// screen and the tips strip show (#485).
    pub(crate) fn first_run() -> Self {
        Self {
            welcomed: false,
            tips_left: TIPS_SESSIONS,
            ..Self::default()
        }
    }
}

/// `forwards` as read from the file: one bad entry (a missing field, a bad
/// port) is skipped instead of losing every saved forward (#217).
fn lenient_forwards<'de, D>(d: D) -> Result<BTreeMap<String, Vec<SavedForward>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use crate::commands::portforward::saved::normalize;
    let Value::Object(by_context) = Value::deserialize(d)? else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    for (ctx, entries) in by_context {
        let Value::Array(entries) = entries else {
            continue;
        };
        let good: Vec<SavedForward> = entries
            .into_iter()
            .filter_map(|v| serde_json::from_value::<SavedForward>(v).ok())
            .filter(|f| !f.id.is_empty())
            .filter_map(|f| normalize(f).ok())
            .collect();
        if !good.is_empty() {
            out.insert(ctx, good);
        }
    }
    Ok(out)
}

/// A change to the settings. Fields left out stay as they are; `contexts`
/// and `kinds` replace only the entries they name.
#[derive(Debug, Clone, Default, Deserialize, Type)]
pub(crate) struct SettingsPatch {
    #[specta(optional)]
    pub(crate) last_context: Option<String>,
    #[specta(optional)]
    pub(crate) theme: Option<Theme>,
    #[specta(optional)]
    pub(crate) logs: Option<LogDefaults>,
    #[specta(optional)]
    pub(crate) check_updates: Option<bool>,
    #[specta(optional)]
    pub(crate) detail_width: Option<u32>,
    #[specta(optional)]
    pub(crate) dock_height: Option<u32>,
    #[specta(optional)]
    pub(crate) contexts: Option<BTreeMap<String, ContextSettings>>,
    #[specta(optional)]
    pub(crate) kinds: Option<BTreeMap<String, KindSettings>>,
    #[specta(optional)]
    pub(crate) windows: Option<Vec<String>>,
    #[specta(optional)]
    pub(crate) favourites: Option<Vec<String>>,
    /// The whole list of hidden context ids.
    #[specta(optional)]
    pub(crate) hidden_contexts: Option<Vec<String>>,
    #[specta(optional)]
    pub(crate) zoom: Option<u32>,
    #[specta(optional)]
    pub(crate) terminal_font_size: Option<u32>,
    #[specta(optional)]
    pub(crate) editor_font_size: Option<u32>,
    #[specta(optional)]
    pub(crate) editor_tab_size: Option<u32>,
    #[specta(optional)]
    pub(crate) time_zone: Option<TimeZone>,
    #[specta(optional)]
    pub(crate) row_height: Option<RowHeight>,
    #[specta(optional)]
    pub(crate) idle_disconnect_minutes: Option<u32>,
    /// The whole search history (#219).
    #[specta(optional)]
    pub(crate) searches: Option<SearchHistory>,
    #[specta(optional)]
    pub(crate) kubectl_match: Option<bool>,
    /// The whole list of collapsed sidebar sections (#383).
    #[specta(optional)]
    pub(crate) collapsed_sections: Option<Vec<String>>,
    /// The whole list of sidebar sections with "More" open (#481).
    #[specta(optional)]
    pub(crate) open_more_sections: Option<Vec<String>>,
    #[specta(optional)]
    pub(crate) ask_ai_cli: Option<String>,
    #[specta(optional)]
    pub(crate) ask_ai_command: Option<String>,
    #[specta(optional)]
    pub(crate) welcomed: Option<bool>,
    #[specta(optional)]
    pub(crate) tips_left: Option<u32>,
    /// The whole image security section (#534).
    #[specta(optional)]
    pub(crate) image_security: Option<ImageSecuritySettings>,
}

impl Settings {
    pub(crate) fn apply(&mut self, patch: SettingsPatch) {
        if let Some(v) = patch.last_context {
            self.last_context = v;
        }
        if let Some(v) = patch.theme {
            self.theme = v;
        }
        if let Some(v) = patch.logs {
            self.logs = v;
        }
        if let Some(v) = patch.check_updates {
            self.check_updates = v;
        }
        if let Some(v) = patch.detail_width {
            self.detail_width = v;
        }
        if let Some(v) = patch.dock_height {
            self.dock_height = v;
        }
        if let Some(v) = patch.windows {
            self.windows = v;
        }
        if let Some(v) = patch.favourites {
            self.favourites = v;
        }
        if let Some(v) = patch.hidden_contexts {
            self.hidden_contexts = unique_ids(v);
        }
        if let Some(v) = patch.zoom {
            self.zoom = v.clamp(ZOOM_RANGE.0, ZOOM_RANGE.1);
        }
        if let Some(v) = patch.terminal_font_size {
            self.terminal_font_size = v.clamp(TERMINAL_FONT_RANGE.0, TERMINAL_FONT_RANGE.1);
        }
        if let Some(v) = patch.editor_font_size {
            self.editor_font_size = v.clamp(EDITOR_FONT_RANGE.0, EDITOR_FONT_RANGE.1);
        }
        if let Some(v) = patch.editor_tab_size {
            self.editor_tab_size = v.clamp(EDITOR_TAB_RANGE.0, EDITOR_TAB_RANGE.1);
        }
        if let Some(v) = patch.time_zone {
            self.time_zone = v;
        }
        if let Some(v) = patch.row_height {
            self.row_height = v;
        }
        if let Some(v) = patch.idle_disconnect_minutes {
            self.idle_disconnect_minutes =
                v.clamp(IDLE_DISCONNECT_RANGE.0, IDLE_DISCONNECT_RANGE.1);
        }
        if let Some(v) = patch.searches {
            self.searches = v.normalized();
        }
        if let Some(v) = patch.kubectl_match {
            self.kubectl_match = v;
        }
        if let Some(v) = patch.collapsed_sections {
            self.collapsed_sections = unique_ids(v);
        }
        if let Some(v) = patch.open_more_sections {
            self.open_more_sections = unique_ids(v);
        }
        if let Some(v) = patch.ask_ai_cli {
            self.ask_ai_cli = v.trim().to_string();
        }
        if let Some(v) = patch.ask_ai_command {
            self.ask_ai_command = v.trim().to_string();
        }
        if let Some(v) = patch.welcomed {
            self.welcomed = v;
        }
        if let Some(v) = patch.tips_left {
            self.tips_left = v.min(TIPS_SESSIONS);
        }
        if let Some(v) = patch.image_security {
            self.image_security = v.normalized();
        }
        for (id, mut ctx) in patch.contexts.unwrap_or_default() {
            // The mode has its own command (#338).
            let old = self.contexts.get(&id).cloned().unwrap_or_default();
            ctx.mode = old.mode;
            ctx.mode_source = old.mode_source;
            self.contexts.insert(id, ctx);
        }
        self.kinds.extend(patch.kinds.unwrap_or_default());
    }
}

/// `ids` without empty and repeated entries, in their first order.
fn unique_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Bring a file written by an older version up to `SETTINGS_VERSION`.
/// Version 1 is the first format, so there is nothing to convert yet: a
/// file without a version (or an older one) keeps every field that still
/// parses.
fn migrate(mut obj: Map<String, Value>) -> Map<String, Value> {
    let version = obj.get("version").and_then(Value::as_u64).unwrap_or(0);
    // Future steps go here, oldest first:
    // if version < 2 { /* rename or convert fields */ }
    let _ = version;
    obj.insert("version".into(), Value::from(SETTINGS_VERSION));
    obj
}

/// Parse a settings file, keeping every top-level field that parses and the
/// defaults for the rest. `None` if the text is not a JSON object at all.
pub(crate) fn parse(text: &str) -> Option<Settings> {
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let obj = migrate(obj);
    if let Ok(s) = serde_json::from_value::<Settings>(Value::Object(obj.clone())) {
        return Some(s);
    }
    // One bad field must not cost the others: keep the fields that parse
    // on their own.
    let good: Map<String, Value> = obj
        .into_iter()
        .filter(|(k, v)| {
            let one = Map::from_iter([(k.clone(), v.clone())]);
            serde_json::from_value::<Settings>(Value::Object(one)).is_ok()
        })
        .collect();
    Some(serde_json::from_value(Value::Object(good)).unwrap_or_default())
}

/// Read the settings at `path`. A missing file gives the defaults; a corrupt
/// one is renamed to `<path>.corrupt` (so it is not overwritten) and gives
/// the defaults too.
pub(crate) fn load(path: &Path) -> Settings {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::first_run(),
        Err(e) => {
            tracing::warn!("could not read {}: {e}", path.display());
            return Settings::default();
        }
    };
    if let Some(s) = parse(&text) {
        return s;
    }
    let aside = corrupt_path(path);
    tracing::warn!(
        "{} is not valid settings JSON; moved it to {} and started with the defaults",
        path.display(),
        aside.display()
    );
    let _ = std::fs::rename(path, aside);
    Settings::default()
}

fn corrupt_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".corrupt");
    path.with_file_name(name)
}

/// Write `settings` to `path` atomically: a temp file next to it, then a
/// rename over it.
pub(crate) fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let json = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// The settings in memory, written to disk shortly after each change.
pub(crate) struct SettingsStore {
    /// `None` when there is no config directory: settings last a session.
    path: Option<PathBuf>,
    current: Mutex<Settings>,
    /// Bumped on every change; a delayed write only runs if it is still the
    /// latest.
    generation: AtomicU64,
    dirty: AtomicBool,
}

impl SettingsStore {
    pub(crate) fn open(path: Option<PathBuf>) -> Arc<Self> {
        let current = path.as_deref().map(load).unwrap_or_default();
        Arc::new(Self {
            path,
            current: Mutex::new(current),
            generation: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
        })
    }

    pub(crate) fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    /// The mode of the context `id` (#338), without copying the settings.
    pub(crate) fn context_mode(&self, id: &str) -> nauvi::context_mode::ContextMode {
        self.current.lock().unwrap().context_mode(id)
    }

    /// Set the mode of the context `id` (#338), with the file and context
    /// it was read from (empty when the catalog has no such context).
    pub(crate) fn set_context_mode_from(
        self: &Arc<Self>,
        id: &str,
        mode: nauvi::context_mode::ContextMode,
        source: nauvi::context_mode::ModeSource,
    ) -> Settings {
        self.modify(|s| {
            let ctx = s.contexts.entry(id.to_string()).or_default();
            ctx.mode = mode;
            ctx.mode_source = source;
        })
    }

    /// [`Self::set_context_mode_from`] without a source, for tests.
    #[cfg(test)]
    pub(crate) fn set_context_mode(
        self: &Arc<Self>,
        id: &str,
        mode: nauvi::context_mode::ContextMode,
    ) -> Settings {
        self.set_context_mode_from(id, mode, Default::default())
    }

    /// Apply `patch` now; the file follows after `WRITE_DELAY` without
    /// further changes.
    pub(crate) fn update(self: &Arc<Self>, patch: SettingsPatch) -> Settings {
        self.modify(|s| s.apply(patch))
    }

    /// Change the settings with `change`, saved like [`Self::update`].
    pub(crate) fn modify(self: &Arc<Self>, change: impl FnOnce(&mut Settings)) -> Settings {
        let next = {
            let mut cur = self.current.lock().unwrap();
            change(&mut cur);
            cur.clone()
        };
        self.dirty.store(true, Ordering::SeqCst);
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let store = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WRITE_DELAY).await;
            if store.generation.load(Ordering::SeqCst) == gen {
                store.flush();
            }
        });
        next
    }

    /// Write pending changes now (also called when the app exits).
    pub(crate) fn flush(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let Some(path) = &self.path else { return };
        let settings = self.get();
        if let Err(e) = save(path, &settings) {
            tracing::warn!("could not save {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nauvi-settings-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let s = parse(r#"{"version":1,"theme":"light"}"#).unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.detail_width, 420);
        assert_eq!(s.logs, LogDefaults::default());
        assert!(s.check_updates);
        assert!(s.contexts.is_empty());

        let s = parse(r#"{"contexts":{"kind":{"view":"v1/pods"}}}"#).unwrap();
        assert_eq!(s.contexts["kind"].view, "v1/pods");
        assert!(s.contexts["kind"].namespaces.is_empty());
        assert!(!s.contexts["kind"].hide_metrics);
    }

    #[test]
    fn metrics_are_hidden_per_context() {
        let s = parse(r#"{"contexts":{"prod":{"hide_metrics":true},"dev":{}}}"#).unwrap();
        assert!(s.metrics_hidden("prod"));
        assert!(!s.metrics_hidden("dev"));
        assert!(!s.metrics_hidden("unknown"));
    }

    #[test]
    fn a_settings_patch_keeps_the_context_mode() {
        use nauvi::context_mode::ContextMode;
        let mut s =
            parse(r#"{"contexts":{"prod":{"mode":"protected","view":"v1/pods","mode_source":{"file":"/k/work.yaml","given":"/k/w.yaml","context":"prod"}}}}"#).unwrap();
        assert_eq!(s.context_mode("prod"), ContextMode::Protected);
        assert_eq!(s.context_mode("dev"), ContextMode::Normal);
        // A window with an older copy writes the entry back without it.
        s.apply(SettingsPatch {
            contexts: Some(BTreeMap::from([
                ("prod".to_string(), ContextSettings::default()),
                (
                    "dev".to_string(),
                    ContextSettings {
                        mode: ContextMode::ReadOnly,
                        ..Default::default()
                    },
                ),
            ])),
            ..Default::default()
        });
        assert_eq!(s.context_mode("prod"), ContextMode::Protected);
        assert_eq!(s.contexts["prod"].mode_source.file, "/k/work.yaml");
        assert_eq!(s.contexts["prod"].mode_source.given, "/k/w.yaml");
        assert_eq!(s.contexts["prod"].view, "");
        assert_eq!(s.context_mode("dev"), ContextMode::Normal);
        // A mode this version does not know is read-only, and costs no other field.
        let s = parse(r#"{"contexts":{"x":{"mode":"locked","view":"v1/pods"}}}"#).unwrap();
        assert_eq!(s.context_mode("x"), ContextMode::ReadOnly);
        assert_eq!(s.contexts["x"].view, "v1/pods");
    }

    #[test]
    fn hidden_contexts_are_a_plain_list() {
        let mut s = Settings::default();
        assert!(s.hidden_contexts.is_empty());
        s.apply(SettingsPatch {
            hidden_contexts: Some(vec!["prod".into(), "".into(), "dev".into(), "prod".into()]),
            ..Default::default()
        });
        assert_eq!(s.hidden_contexts, ["prod", "dev"]);
        // A patch without it keeps it.
        s.apply(SettingsPatch {
            theme: Some(Theme::Dark),
            ..Default::default()
        });
        assert_eq!(s.hidden_contexts, ["prod", "dev"]);
        // A file from before has none; a bad value costs no other field.
        assert!(parse("{}").unwrap().hidden_contexts.is_empty());
        let s = parse(r#"{"hidden_contexts":"prod","theme":"light"}"#).unwrap();
        assert!(s.hidden_contexts.is_empty());
        assert_eq!(s.theme, Theme::Light);
    }

    #[test]
    fn collapsed_sections_survive_a_restart() {
        let mut s = Settings::default();
        assert!(s.collapsed_sections.is_empty());
        s.apply(SettingsPatch {
            collapsed_sections: Some(vec![
                "network".into(),
                "".into(),
                "network".into(),
                "helm".into(),
            ]),
            ..Default::default()
        });
        assert_eq!(s.collapsed_sections, ["network", "helm"]);
        let saved = serde_json::to_string(&s).unwrap();
        assert_eq!(
            parse(&saved).unwrap().collapsed_sections,
            ["network", "helm"]
        );
        // A file from before has none; a bad value costs no other field.
        assert!(parse("{}").unwrap().collapsed_sections.is_empty());
        let s = parse(r#"{"collapsed_sections":3,"theme":"light"}"#).unwrap();
        assert!(s.collapsed_sections.is_empty());
        assert_eq!(s.theme, Theme::Light);
    }

    #[test]
    fn open_more_sections_survive_a_restart() {
        let mut s = Settings::default();
        assert!(s.open_more_sections.is_empty());
        s.apply(SettingsPatch {
            open_more_sections: Some(vec!["config".into(), "".into(), "config".into()]),
            ..Default::default()
        });
        assert_eq!(s.open_more_sections, ["config"]);
        let saved = serde_json::to_string(&s).unwrap();
        assert_eq!(parse(&saved).unwrap().open_more_sections, ["config"]);
        assert!(parse("{}").unwrap().open_more_sections.is_empty());
        let s = parse(r#"{"open_more_sections":"x","theme":"light"}"#).unwrap();
        assert!(s.open_more_sections.is_empty());
        assert_eq!(s.theme, Theme::Light);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let s = parse(
            r#"{"version":1,"theme":"dark","fromTheFuture":[1,2],"logs":{"wrap":true,"x":1}}"#,
        )
        .unwrap();
        assert_eq!(s.theme, Theme::Dark);
        assert!(s.logs.wrap);
        assert_eq!(s.logs.tail, "200");
    }

    #[test]
    fn a_bad_field_keeps_the_others() {
        let s = parse(r#"{"theme":"purple","detail_width":"wide","last_context":"prod"}"#).unwrap();
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.detail_width, 420);
        assert_eq!(s.last_context, "prod");
    }

    #[test]
    fn older_versions_are_migrated() {
        // No version (or 0): read what parses and write the current version.
        let s = parse(r#"{"last_context":"kind-test","kinds":{"v1/pods":{"sort_key":"age","sort_desc":true}}}"#)
            .unwrap();
        assert_eq!(s.version, SETTINGS_VERSION);
        assert_eq!(s.last_context, "kind-test");
        assert_eq!(s.kinds["v1/pods"].sort_key, "age");
        assert!(s.kinds["v1/pods"].sort_desc);
        // From before off-by-default columns (#378): none turned on.
        assert!(s.kinds["v1/pods"].shown.is_empty());
        // From before fitted columns (#482): every column fits its values.
        assert!(s.kinds["v1/pods"].widths.is_empty());
        let sized = parse(r#"{"kinds":{"v1/pods":{"widths":{"name":320}}}}"#).unwrap();
        assert_eq!(sized.kinds["v1/pods"].widths["name"], 320);
        let on = parse(r#"{"kinds":{"v1/pods":{"hidden":["node"],"shown":["qos"]}}}"#).unwrap();
        assert_eq!(on.kinds["v1/pods"].shown, ["qos"]);
        assert_eq!(parse(r#"{"version":0}"#).unwrap().version, SETTINGS_VERSION);
    }

    #[test]
    fn not_json_is_rejected() {
        assert!(parse("{not json").is_none());
        assert!(parse("[1,2]").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn a_corrupt_file_is_set_aside() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{\"theme\": ").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(corrupt_path(&path)).unwrap(),
            "{\"theme\": "
        );
    }

    #[test]
    fn a_missing_file_is_a_first_run() {
        let path = temp_path("missing");
        let s = load(&path);
        assert_eq!(s, Settings::first_run());
        assert!(!s.welcomed);
        assert_eq!(s.tips_left, TIPS_SESSIONS);
        assert_eq!(
            Settings {
                welcomed: true,
                tips_left: 0,
                ..s
            },
            Settings::default()
        );
    }

    #[test]
    fn a_file_from_before_the_welcome_counts_as_welcomed() {
        let s = parse(r#"{"version":1,"theme":"light"}"#).unwrap();
        assert!(s.welcomed);
        assert_eq!(s.tips_left, 0);
        let mut s = Settings::first_run();
        s.apply(SettingsPatch {
            tips_left: Some(99),
            ..Default::default()
        });
        assert_eq!(s.tips_left, TIPS_SESSIONS);
        s.apply(SettingsPatch {
            welcomed: Some(true),
            tips_left: Some(0),
            ..Default::default()
        });
        assert!(s.welcomed);
        assert_eq!(s.tips_left, 0);
    }

    #[test]
    fn save_and_load_round_trip() {
        let path = temp_path("roundtrip");
        let mut s = Settings::default();
        s.apply(SettingsPatch {
            theme: Some(Theme::Light),
            detail_width: Some(600),
            contexts: Some(BTreeMap::from([(
                "kind".to_string(),
                ContextSettings {
                    view: "apps/v1/deployments".into(),
                    namespaces: vec!["demo".into()],
                    typed_namespaces: vec!["team-a".into()],
                    prometheus: "monitoring/prometheus-k8s:web".into(),
                    display_name: "Dev".into(),
                    color: "#3b82f6".into(),
                    default_namespace: "demo".into(),
                    shell_cwd: "~/src".into(),
                    last_used: 1_700_000_000_000,
                    hide_metrics: true,
                    mode: Default::default(),
                    mode_source: Default::default(),
                    image_security: ImageSecurityMode::On,
                },
            )])),
            favourites: Some(vec!["kind".into(), "prod (work.yaml)".into()]),
            ..Default::default()
        });
        s.kubeconfig_sources = vec!["/home/u/kc".into()];
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        assert!(!path.with_file_name("settings.json.tmp").exists());
    }

    #[test]
    fn patches_merge_map_entries() {
        let mut s = Settings::default();
        let kind = |key: &str| KindSettings {
            sort_key: key.into(),
            ..Default::default()
        };
        s.apply(SettingsPatch {
            kinds: Some(BTreeMap::from([
                ("a".into(), kind("name")),
                ("b".into(), kind("age")),
            ])),
            ..Default::default()
        });
        s.apply(SettingsPatch {
            kinds: Some(BTreeMap::from([("a".into(), kind("status"))])),
            last_context: Some("prod".into()),
            ..Default::default()
        });
        assert_eq!(s.kinds["a"].sort_key, "status");
        assert_eq!(s.kinds["b"].sort_key, "age");
        assert_eq!(s.last_context, "prod");
        assert_eq!(s.theme, Theme::System);
    }

    #[test]
    fn zoom_and_terminal_font_are_kept_in_range() {
        let mut s = Settings::default();
        assert_eq!((s.zoom, s.terminal_font_size), (100, 12));
        s.apply(SettingsPatch {
            zoom: Some(500),
            terminal_font_size: Some(2),
            ..Default::default()
        });
        assert_eq!((s.zoom, s.terminal_font_size), (200, 8));
        s.apply(SettingsPatch {
            zoom: Some(125),
            terminal_font_size: Some(16),
            ..Default::default()
        });
        assert_eq!((s.zoom, s.terminal_font_size), (125, 16));
    }

    #[test]
    fn editor_and_display_preferences() {
        let mut s = Settings::default();
        assert_eq!((s.editor_font_size, s.editor_tab_size), (12, 2));
        assert_eq!(
            (s.time_zone, s.row_height),
            (TimeZone::Local, RowHeight::Normal)
        );
        s.apply(SettingsPatch {
            editor_font_size: Some(99),
            editor_tab_size: Some(0),
            time_zone: Some(TimeZone::Utc),
            row_height: Some(RowHeight::Compact),
            ..Default::default()
        });
        assert_eq!((s.editor_font_size, s.editor_tab_size), (32, 1));
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            json.contains(r#""time_zone":"utc""#) && json.contains(r#""row_height":"compact""#)
        );
        // An unknown value keeps the default, the other fields stay.
        let s =
            parse(r#"{"time_zone":"mars","row_height":"compact","editor_tab_size":4}"#).unwrap();
        assert_eq!(
            (s.time_zone, s.row_height, s.editor_tab_size),
            (TimeZone::Local, RowHeight::Compact, 4)
        );
    }

    #[test]
    fn idle_disconnect_defaults_to_ten_minutes_and_zero_is_never() {
        let mut s = Settings::default();
        assert_eq!(s.idle_disconnect_minutes, 10);
        s.apply(SettingsPatch {
            idle_disconnect_minutes: Some(0),
            ..Default::default()
        });
        assert_eq!(s.idle_disconnect_minutes, 0);
        s.apply(SettingsPatch {
            idle_disconnect_minutes: Some(100_000),
            ..Default::default()
        });
        assert_eq!(s.idle_disconnect_minutes, 24 * 60);
        // A file from before keeps the default.
        assert_eq!(parse("{}").unwrap().idle_disconnect_minutes, 10);
    }

    #[test]
    fn a_bad_saved_forward_keeps_the_others() {
        let s = parse(
            r#"{"theme":"dark","forwards":{
                "kind":[
                  {"id":"a","target":{"kind":"pod","namespace":"demo","name":"web"},"remote":"8080","local_port":"","https":false,"open_in_browser":false,"auto_start":true},
                  {"id":"b","target":{"kind":"pod","namespace":"demo","name":"web"},"remote":"99999","local_port":"","https":false,"open_in_browser":false,"auto_start":false},
                  {"id":"c","target":{"kind":"pod","namespace":"demo","name":"web"},"remote":"80","local_port":"x","https":false,"open_in_browser":false,"auto_start":false},
                  {"id":"d","target":{"kind":"teapot","namespace":"demo","name":"web"},"remote":"80","local_port":"","https":false,"open_in_browser":false,"auto_start":false},
                  {"id":"e","remote":"80"},
                  "nonsense",
                  {"id":"f","target":{"kind":"service","namespace":"demo","name":"api"},"remote":"http","local_port":" 9000 ","https":true,"open_in_browser":true,"auto_start":false}
                ],
                "prod":"not a list",
                "empty":[{"id":"x"}]}}"#,
        )
        .unwrap();
        assert_eq!(s.theme, Theme::Dark);
        let ids: Vec<&str> = s.forwards["kind"].iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["a", "f"]);
        // Ports are validated and normalized on load.
        assert_eq!(s.forwards["kind"][1].local_port, "9000");
        assert_eq!(
            s.forwards.len(),
            1,
            "contexts with nothing valid are dropped"
        );
        // Not an object at all: no forwards, the rest kept.
        let s = parse(r#"{"theme":"light","forwards":[1,2]}"#).unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert!(s.forwards.is_empty());
    }

    #[test]
    fn search_history_is_capped_and_cleaned() {
        let search = |text: &str| SavedSearch {
            text: text.into(),
            ..Default::default()
        };
        let mut s = Settings::default();
        let mut recent: Vec<SavedSearch> = (0..15).map(|i| search(&format!("q{i}"))).collect();
        recent.insert(1, search("q0"));
        recent.insert(2, search("  "));
        recent.insert(3, search(&"x".repeat(MAX_SEARCH_LEN + 1)));
        s.apply(SettingsPatch {
            searches: Some(SearchHistory {
                recent,
                starred: vec![
                    SavedSearch {
                        text: "^web-".into(),
                        regex: true,
                        match_case: false,
                    },
                    search("^web-"),
                ],
            }),
            ..Default::default()
        });
        let texts: Vec<&str> = s.searches.recent.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            texts,
            ["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"]
        );
        // The same text with other toggles is another search.
        assert_eq!(s.searches.starred.len(), 2);
        assert!(s.searches.starred[0].regex);

        // Read back from a file, a bad entry keeps its defaults.
        let s =
            parse(r#"{"searches":{"recent":[{"text":"web","match_case":true},{"text":"db"}]}}"#)
                .unwrap();
        assert_eq!(s.searches.recent.len(), 2);
        assert!(s.searches.recent[0].match_case);
        assert!(!s.searches.recent[0].regex);
        assert!(s.searches.starred.is_empty());

        // One bad entry is skipped; the other entries and the starred list stay.
        let s = parse(
            r#"{"theme":"dark","searches":{
                "recent":[{"text":3},{"text":"web"},"nonsense",{"text":""},{"text":"web"}],
                "starred":[{"text":"^db-","regex":true},{"regex":"yes"}]}}"#,
        )
        .unwrap();
        assert_eq!(s.theme, Theme::Dark);
        let texts: Vec<&str> = s.searches.recent.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["web"]);
        assert_eq!(s.searches.starred.len(), 1);
        assert!(s.searches.starred[0].regex);
        // Not an object, or lists that are not lists: empty, the rest kept.
        let s = parse(r#"{"theme":"light","searches":[1,2]}"#).unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.searches, SearchHistory::default());
        let s = parse(r#"{"searches":{"recent":"x","starred":[{"text":"a"}]}}"#).unwrap();
        assert!(s.searches.recent.is_empty());
        assert_eq!(s.searches.starred[0].text, "a");
    }

    #[test]
    fn the_patch_accepts_partial_json() {
        let p: SettingsPatch = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(p.theme, Some(Theme::Dark));
        assert!(p.kinds.is_none());
    }

    #[test]
    fn flush_writes_only_when_changed() {
        let path = temp_path("flush");
        let store = SettingsStore::open(Some(path.clone()));
        store.flush();
        assert!(!path.exists());
        store.current.lock().unwrap().theme = Theme::Dark;
        store.dirty.store(true, Ordering::SeqCst);
        store.flush();
        assert_eq!(load(&path).theme, Theme::Dark);
    }
}
