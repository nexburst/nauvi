//! What the app says about itself in About, "Copy diagnostics" and a bug
//! report (#208): the version and commit, the OS and the webview.
//!
//! Only these facts: no paths (they name the user), no contexts, servers,
//! settings or environment values.

use serde::Serialize;
use specta::Type;
use std::sync::OnceLock;

/// The repository, for the Help menu's links.
pub(crate) const REPO_URL: &str = "https://github.com/pedrosanzmtz/kubeloupe";
/// Help → Documentation.
pub(crate) const DOCS_URL: &str = "https://github.com/pedrosanzmtz/kubeloupe#readme";

/// The app's version (Cargo's, the same as `tauri.conf.json`'s).
pub(crate) const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The commit it was built from (`build.rs`), or "unknown".
pub(crate) const COMMIT: &str = env!("KUBELOUPE_COMMIT");

/// The facts in About and in the copied diagnostics.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct Diagnostics {
    pub(crate) version: String,
    pub(crate) commit: String,
    /// The OS and its version, e.g. "Ubuntu 24.04.1 LTS, Linux 6.8.0".
    pub(crate) os: String,
    pub(crate) arch: String,
    /// The webview engine and its version.
    pub(crate) webview: String,
    /// Whether this is a debug build (`cargo tauri dev`).
    pub(crate) debug_build: bool,
    /// All of the above as text, for the clipboard and a bug report.
    pub(crate) text: String,
}

/// The diagnostics (worked out once: the OS and webview do not change).
pub(crate) fn collect() -> Diagnostics {
    static CACHE: OnceLock<Diagnostics> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut d = Diagnostics {
                version: VERSION.into(),
                commit: COMMIT.into(),
                os: os_version(),
                arch: std::env::consts::ARCH.into(),
                webview: webview_version(),
                debug_build: cfg!(debug_assertions),
                text: String::new(),
            };
            d.text = text(&d);
            d
        })
        .clone()
}

/// The copied text: one fact per line.
fn text(d: &Diagnostics) -> String {
    let build = if d.debug_build { " (debug build)" } else { "" };
    format!(
        "kubeloupe {}{build}\nCommit: {}\nOS: {} ({})\nWebview: {}",
        d.version, d.commit, d.os, d.arch, d.webview
    )
}

/// The first line of every run's log.
pub(crate) fn summary_line() -> String {
    let d = collect();
    format!(
        "kubeloupe {} ({}) starting on {} ({}), webview {}",
        d.version, d.commit, d.os, d.arch, d.webview
    )
}

/// Help → Report a bug: a new issue with the diagnostics filled in.
pub(crate) fn bug_report_url() -> String {
    let body = format!(
        "**What happened**\n\n\n**What you expected**\n\n\n**Steps to reproduce**\n\n1. \n\n\
         **Diagnostics**\n\n```\n{}\n```\n\n\
         <!-- The app log (Help → Open log folder) can help too. Check it for \
         names you would rather not share before you attach it. -->\n",
        collect().text
    );
    let mut url = url::Url::parse(&format!("{REPO_URL}/issues/new")).expect("valid URL");
    url.query_pairs_mut().append_pair("body", &body);
    url.into()
}

fn webview_version() -> String {
    let engine = if cfg!(target_os = "linux") {
        "WebKitGTK"
    } else if cfg!(target_os = "windows") {
        "WebView2"
    } else {
        "WKWebView"
    };
    match tauri::webview_version() {
        Ok(v) => format!("{engine} {v}"),
        Err(_) => format!("{engine} (version unknown)"),
    }
}

#[cfg(target_os = "linux")]
fn os_version() -> String {
    let name = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|t| os_release_name(&t))
        .unwrap_or_else(|| "Linux".into());
    match std::fs::read_to_string("/proc/sys/kernel/osrelease") {
        Ok(kernel) => format!("{name}, Linux {}", kernel.trim()),
        Err(_) => name,
    }
}

/// `PRETTY_NAME` (or `NAME`) from an os-release file.
#[cfg(any(target_os = "linux", test))]
fn os_release_name(text: &str) -> Option<String> {
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
            .map(|v| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
    };
    field("PRETTY_NAME").or_else(|| field("NAME"))
}

#[cfg(target_os = "macos")]
fn os_version() -> String {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output();
    match out {
        Ok(o) if o.status.success() => {
            format!("macOS {}", String::from_utf8_lossy(&o.stdout).trim())
        }
        _ => "macOS".into(),
    }
}

/// Read from the registry, not `cmd /C ver`: that prints in the console's
/// code page and the system's language ("Versión" came out with a U+FFFD
/// on a Spanish Windows, #294).
#[cfg(target_os = "windows")]
fn os_version() -> String {
    let Ok(key) =
        windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
    else {
        return "Windows".into();
    };
    let text = |name: &str| key.get_string(name).unwrap_or_default();
    let mut build = text("CurrentBuild");
    if build.trim().is_empty() {
        build = text("CurrentBuildNumber");
    }
    windows_version_text(
        &text("ProductName"),
        &text("DisplayVersion"),
        &build,
        key.get_u32("UBR").ok(),
    )
}

/// "Windows 10 Pro 22H2 (build 19045.6466)" from the registry's
/// `ProductName`, `DisplayVersion`, `CurrentBuild` and `UBR`; empty values
/// are left out. Windows 11 still says "Windows 10" in `ProductName`, so a
/// build of 22000 or later renames it.
#[cfg(any(target_os = "windows", test))]
fn windows_version_text(product: &str, display: &str, build: &str, ubr: Option<u32>) -> String {
    let (product, display, build) = (product.trim(), display.trim(), build.trim());
    let is_11 = build.parse::<u32>().is_ok_and(|b| b >= 22000);
    let mut out = match product.strip_prefix("Windows 10") {
        Some(rest) if is_11 => format!("Windows 11{rest}"),
        _ if product.is_empty() => "Windows".to_string(),
        _ => product.to_string(),
    };
    if !display.is_empty() {
        out.push(' ');
        out.push_str(display);
    }
    match (build.is_empty(), ubr) {
        (true, _) => {}
        (false, Some(ubr)) => out.push_str(&format!(" (build {build}.{ubr})")),
        (false, None) => out.push_str(&format!(" (build {build})")),
    }
    out
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn os_version() -> String {
    std::env::consts::OS.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_os_release_name() {
        let text = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        assert_eq!(os_release_name(text).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(
            os_release_name("NAME=Arch Linux\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(os_release_name("ID=x\n"), None);
    }

    #[test]
    fn formats_the_windows_version() {
        // The values of the Spanish Windows 10 in #294.
        assert_eq!(
            windows_version_text("Windows 10 Pro", "22H2", "19045", Some(6466)),
            "Windows 10 Pro 22H2 (build 19045.6466)"
        );
        // Windows 11 keeps "Windows 10" in ProductName.
        assert_eq!(
            windows_version_text("Windows 10 Home", "24H2", "26100", Some(2314)),
            "Windows 11 Home 24H2 (build 26100.2314)"
        );
        // Older Windows has no DisplayVersion; Server names stay as they are.
        assert_eq!(
            windows_version_text("Windows Server 2019 Datacenter", "", "17763", None),
            "Windows Server 2019 Datacenter (build 17763)"
        );
        assert_eq!(windows_version_text("", "", "", None), "Windows");
    }

    #[test]
    fn the_text_has_each_fact_and_nothing_personal() {
        let d = collect();
        for part in [&d.version, &d.commit, &d.os, &d.arch, &d.webview] {
            assert!(d.text.contains(part.as_str()), "{part} in {}", d.text);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy();
            assert!(
                !d.text.contains(home.as_ref()),
                "no home folder in {}",
                d.text
            );
        }
        if let Ok(user) = std::env::var("USER") {
            assert!(
                !d.text.contains(&format!("/{user}")),
                "no user name in {}",
                d.text
            );
        }
    }

    #[test]
    fn the_bug_url_carries_the_diagnostics() {
        let url = url::Url::parse(&bug_report_url()).unwrap();
        assert_eq!(
            url.as_str().split('?').next(),
            Some(&*format!("{REPO_URL}/issues/new"))
        );
        let body = url
            .query_pairs()
            .find(|(k, _)| k == "body")
            .map(|(_, v)| v.into_owned())
            .unwrap();
        assert!(body.contains(&collect().text));
    }
}
