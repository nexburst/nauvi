//! The rules of the in-app update check (#30), kept free of Tauri calls so
//! they are unit tested: when to check, which version counts as newer, and
//! whether this copy can install an update itself or must send the user to
//! the release page. `commands/updater.rs` runs the check and the install
//! with `tauri-plugin-updater`.

use semver::Version;
use tauri::utils::config::BundleType;

/// Where people download releases by hand.
pub(crate) const RELEASES_URL: &str = "https://github.com/pedrosanzmtz/kubeloupe/releases";

/// Points debug builds at another `latest.json` (for example one served by
/// `python3 -m http.server`). Release builds ignore it.
pub(crate) const ENDPOINT_ENV: &str = "KUBELOUPE_UPDATE_ENDPOINT";

/// Points debug builds at another executable path for the location check
/// (`/Volumes/kubeloupe/kubeloupe.app/...`), so the QA scenario can show
/// the note on Linux. Release builds ignore it.
pub(crate) const EXE_PATH_ENV: &str = "KUBELOUPE_UPDATE_EXE_PATH";

/// The release page of `version` (`0.2.0` or `v0.2.0`).
pub(crate) fn release_page(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{}", version.trim_start_matches('v'))
}

/// Why a check did not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Skip {
    /// The start-up check is turned off in Settings.
    TurnedOff,
    /// Debug builds make no network call unless `ENDPOINT_ENV` is set.
    DebugBuild,
}

impl Skip {
    pub(crate) fn message(self) -> String {
        match self {
            Skip::TurnedOff => "The update check on start is turned off in Settings.".into(),
            Skip::DebugBuild => format!(
                "Development builds do not check for updates. Set {ENDPOINT_ENV} to a latest.json URL to test the check."
            ),
        }
    }
}

/// Whether to check now. `startup`: the check on start (which the setting
/// can turn off); otherwise the user asked. `debug`: a debug build;
/// `endpoint_override`: `ENDPOINT_ENV` is set.
pub(crate) fn skip_reason(
    startup: bool,
    check_on_start: bool,
    debug: bool,
    endpoint_override: bool,
) -> Option<Skip> {
    if debug && !endpoint_override {
        return Some(Skip::DebugBuild);
    }
    if startup && !check_on_start {
        return Some(Skip::TurnedOff);
    }
    None
}

/// The endpoint override, read only by debug builds. An empty value is no
/// override; a value that is not a URL is an error, not a silent fallback
/// to the real endpoint.
pub(crate) fn endpoint_override(
    debug: bool,
    value: Option<String>,
) -> Result<Option<url::Url>, String> {
    if !debug {
        return Ok(None);
    }
    let Some(value) = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    url::Url::parse(&value)
        .map(Some)
        .map_err(|e| format!("{ENDPOINT_ENV} is not a valid URL ({value}): {e}"))
}

/// Whether `remote` is an update for `current`. A stable build is not
/// offered a pre-release; a pre-release build is offered the next
/// pre-release and the final release.
pub(crate) fn is_newer(current: &Version, remote: &Version) -> bool {
    remote > current && (remote.pre.is_empty() || !current.pre.is_empty())
}

/// Whether this copy can install the update itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallSupport {
    pub(crate) can_install: bool,
    /// Why not, and what to do instead (empty when it can).
    pub(crate) note: String,
}

impl InstallSupport {
    fn yes() -> Self {
        Self {
            can_install: true,
            note: String::new(),
        }
    }
    fn no(note: impl Into<String>) -> Self {
        Self {
            can_install: false,
            note: note.into(),
        }
    }
}

/// Where this copy runs from, when that place cannot be updated in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadOnlyLocation {
    /// Straight from the mounted disk image (`/Volumes/<name>/kubeloupe.app`).
    DiskImage,
    /// A Gatekeeper-translocated copy
    /// (`/private/var/folders/…/AppTranslocation/<uuid>/d/kubeloupe.app`):
    /// macOS runs a quarantined app that was not moved by Finder from a
    /// random read-only path.
    Translocated,
}

impl ReadOnlyLocation {
    pub(crate) fn note(self) -> &'static str {
        match self {
            ReadOnlyLocation::DiskImage => {
                "kubeloupe is running from the disk image, which is read-only. Move kubeloupe to Applications to update it in place, or download the new version from the release page."
            }
            ReadOnlyLocation::Translocated => {
                "macOS runs this copy of kubeloupe from a temporary read-only location (App Translocation). Move kubeloupe to Applications with Finder to update it in place, or download the new version from the release page."
            }
        }
    }
}

/// Whether the executable at `exe` runs from a place an update cannot
/// replace. `exe` is `std::env::current_exe()`, for example
/// `/Applications/kubeloupe.app/Contents/MacOS/kubeloupe`.
pub(crate) fn read_only_location(exe: &str) -> Option<ReadOnlyLocation> {
    if exe.contains("/AppTranslocation/") {
        Some(ReadOnlyLocation::Translocated)
    } else if exe.starts_with("/Volumes/") {
        Some(ReadOnlyLocation::DiskImage)
    } else {
        None
    }
}

/// The executable path for the location check: `EXE_PATH_ENV` in debug
/// builds when set, else `actual`.
pub(crate) fn exe_path(
    debug: bool,
    override_value: Option<String>,
    actual: Option<String>,
) -> String {
    override_value
        .filter(|v| debug && !v.trim().is_empty())
        .or(actual)
        .unwrap_or_default()
}

/// Whether the update can be installed in place, given where this copy
/// runs from (`exe`, see `read_only_location`), how it was
/// installed (`bundle`, from `tauri::utils::platform::bundle_type`), the
/// updater target (`linux-x86_64`) and the target keys of the release's
/// `latest.json`.
///
/// tauri-plugin-updater 2.14 installs an AppImage, a macOS .app, an MSI and
/// an NSIS setup. It also installs a .deb (with `pkexec dpkg -i`) or an .rpm,
/// but only from a signed `<target>-deb` / `<target>-rpm` entry: without
/// one it would fall back to the AppImage entry and fail, so then the user
/// is sent to the release page instead. A binary that was not installed
/// from a bundle (`cargo build`) cannot update itself. A copy on a disk
/// image or a translocated one cannot be replaced, whatever its bundle.
pub(crate) fn install_support<S: AsRef<str>>(
    exe: &str,
    bundle: Option<BundleType>,
    target: &str,
    platforms: &[S],
) -> InstallSupport {
    if let Some(place) = read_only_location(exe) {
        return InstallSupport::no(place.note());
    }
    let has = |key: &str| platforms.iter().any(|p| p.as_ref() == key);
    match bundle {
        None => InstallSupport::no(
            "This copy was not installed from a release download, so it cannot update itself. Download the new version from the release page.",
        ),
        Some(BundleType::Deb) if !has(&format!("{target}-deb")) => InstallSupport::no(
            "kubeloupe was installed from a .deb package, and this release has no signed .deb update. Download the new .deb from the release page and install it with your package manager.",
        ),
        Some(BundleType::Rpm) if !has(&format!("{target}-rpm")) => InstallSupport::no(
            "kubeloupe was installed from an .rpm package, and this release has no signed .rpm update. Download the new version from the release page.",
        ),
        Some(_) => InstallSupport::yes(),
    }
}

/// The target keys of a `latest.json` (`linux-x86_64`, `linux-x86_64-appimage`, …).
pub(crate) fn platform_keys(raw: &serde_json::Value) -> Vec<String> {
    raw.get("platforms")
        .and_then(|p| p.as_object())
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn newer_versions() {
        assert!(is_newer(&v("0.1.0"), &v("0.1.1")));
        assert!(is_newer(&v("0.1.0"), &v("0.2.0")));
        assert!(is_newer(&v("0.9.9"), &v("1.0.0")));
        assert!(!is_newer(&v("0.1.0"), &v("0.1.0")));
        assert!(!is_newer(&v("0.2.0"), &v("0.1.9")));
    }

    #[test]
    fn pre_releases_only_for_pre_release_builds() {
        // Numeric pre-releases, as the release workflow requires.
        assert!(!is_newer(&v("0.1.0"), &v("0.2.0-1")));
        assert!(is_newer(&v("0.2.0-1"), &v("0.2.0-2")));
        assert!(is_newer(&v("0.2.0-1"), &v("0.2.0")));
        assert!(is_newer(&v("0.2.0-1"), &v("0.3.0-1")));
        assert!(!is_newer(&v("0.2.0"), &v("0.2.0-5")));
    }

    #[test]
    fn debug_builds_never_check_without_an_override() {
        assert_eq!(skip_reason(true, true, true, false), Some(Skip::DebugBuild));
        assert_eq!(
            skip_reason(false, true, true, false),
            Some(Skip::DebugBuild)
        );
        assert_eq!(skip_reason(false, true, true, true), None);
        assert_eq!(skip_reason(true, true, true, true), None);
    }

    #[test]
    fn the_setting_turns_off_only_the_startup_check() {
        assert_eq!(
            skip_reason(true, false, false, false),
            Some(Skip::TurnedOff)
        );
        assert_eq!(skip_reason(false, false, false, false), None);
        assert_eq!(skip_reason(true, true, false, false), None);
        // An override in a debug build still respects the setting.
        assert_eq!(skip_reason(true, false, true, true), Some(Skip::TurnedOff));
    }

    #[test]
    fn the_endpoint_override_is_read_by_debug_builds_only() {
        let local = Some("http://127.0.0.1:8000/latest.json".to_string());
        assert_eq!(endpoint_override(false, local.clone()), Ok(None));
        assert_eq!(
            endpoint_override(true, local).unwrap().unwrap().as_str(),
            "http://127.0.0.1:8000/latest.json"
        );
        assert_eq!(endpoint_override(true, None), Ok(None));
        assert_eq!(endpoint_override(true, Some("  ".into())), Ok(None));
        let err = endpoint_override(true, Some("not a url".into())).unwrap_err();
        assert!(err.contains(ENDPOINT_ENV), "{err}");
    }

    #[test]
    fn release_pages() {
        assert_eq!(
            release_page("0.2.0"),
            "https://github.com/pedrosanzmtz/kubeloupe/releases/tag/v0.2.0"
        );
        assert_eq!(release_page("v0.2.0"), release_page("0.2.0"));
    }

    const INSTALLED: &str = "/Applications/kubeloupe.app/Contents/MacOS/kubeloupe";

    const ACTION_KEYS: &[&str] = &[
        "linux-x86_64",
        "linux-x86_64-appimage",
        "darwin-aarch64",
        "darwin-x86_64",
        "darwin-aarch64-app",
        "darwin-x86_64-app",
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
    ];

    #[test]
    fn bundles_that_install_themselves() {
        for b in [
            BundleType::AppImage,
            BundleType::App,
            BundleType::Msi,
            BundleType::Nsis,
        ] {
            assert!(install_support(INSTALLED, Some(b), "linux-x86_64", ACTION_KEYS).can_install);
        }
    }

    #[test]
    fn a_deb_needs_a_signed_deb_entry() {
        let s = install_support(
            INSTALLED,
            Some(BundleType::Deb),
            "linux-x86_64",
            ACTION_KEYS,
        );
        assert!(!s.can_install);
        assert!(s.note.contains(".deb"), "{}", s.note);

        let mut keys = ACTION_KEYS.to_vec();
        keys.push("linux-x86_64-deb");
        assert!(
            install_support(INSTALLED, Some(BundleType::Deb), "linux-x86_64", &keys).can_install
        );
        assert!(
            !install_support(INSTALLED, Some(BundleType::Rpm), "linux-x86_64", &keys).can_install
        );
    }

    #[test]
    fn a_plain_binary_cannot_update_itself() {
        let s = install_support(INSTALLED, None, "linux-x86_64", ACTION_KEYS);
        assert!(!s.can_install);
        assert!(s.note.contains("release page"), "{}", s.note);
    }

    // Paths of the macOS test machine (#159).
    const DMG: &str = "/Volumes/kubeloupe/kubeloupe.app/Contents/MacOS/kubeloupe";
    const TRANSLOCATED: &str = "/private/var/folders/7k/2lyy0kc93xs3m1qz5jw0t8hr0000gn/T/AppTranslocation/0F4D3A6E-58B4-4E3B-9C2A-6A0E7A8D1F42/d/kubeloupe.app/Contents/MacOS/kubeloupe";

    #[test]
    fn read_only_locations() {
        assert_eq!(read_only_location(DMG), Some(ReadOnlyLocation::DiskImage));
        assert_eq!(
            read_only_location("/Volumes/kubeloupe 0.1.0/kubeloupe.app/Contents/MacOS/kubeloupe"),
            Some(ReadOnlyLocation::DiskImage)
        );
        assert_eq!(
            read_only_location(TRANSLOCATED),
            Some(ReadOnlyLocation::Translocated)
        );
        for ok in [
            INSTALLED,
            "/Users/qa/Applications/kubeloupe.app/Contents/MacOS/kubeloupe",
            "/Users/qa/Volumes/kubeloupe.app/Contents/MacOS/kubeloupe",
            "/opt/homebrew/Caskroom/kubeloupe/0.1.0/kubeloupe.app/Contents/MacOS/kubeloupe",
            "/home/qa/Applications/kubeloupe_0.1.0_amd64.AppImage",
            r"C:\Program Files\kubeloupe\kubeloupe.exe",
            "",
        ] {
            assert_eq!(read_only_location(ok), None, "{ok}");
        }
    }

    #[test]
    fn a_disk_image_or_translocated_copy_cannot_install() {
        for exe in [DMG, TRANSLOCATED] {
            let s = install_support(exe, Some(BundleType::App), "darwin-aarch64", ACTION_KEYS);
            assert!(!s.can_install, "{exe}");
            assert!(
                s.note.contains("Move kubeloupe to Applications"),
                "{}",
                s.note
            );
        }
        let s = install_support(
            INSTALLED,
            Some(BundleType::App),
            "darwin-aarch64",
            ACTION_KEYS,
        );
        assert!(s.can_install);
        assert!(s.note.is_empty());
    }

    #[test]
    fn the_exe_path_override_is_read_by_debug_builds_only() {
        let actual = Some(INSTALLED.to_string());
        assert_eq!(exe_path(false, Some(DMG.into()), actual.clone()), INSTALLED);
        assert_eq!(exe_path(true, Some(DMG.into()), actual.clone()), DMG);
        assert_eq!(exe_path(true, Some(" ".into()), actual.clone()), INSTALLED);
        assert_eq!(exe_path(true, None, actual), INSTALLED);
        assert_eq!(exe_path(true, None, None), "");
    }

    #[test]
    fn platform_keys_of_latest_json() {
        let raw = serde_json::json!({
            "version": "0.2.0",
            "platforms": { "linux-x86_64": {}, "windows-x86_64-msi": {} }
        });
        let mut keys = platform_keys(&raw);
        keys.sort();
        assert_eq!(keys, ["linux-x86_64", "windows-x86_64-msi"]);
        assert!(platform_keys(&serde_json::json!({})).is_empty());
    }
}
