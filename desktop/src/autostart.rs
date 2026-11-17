//! Start at login (#330), through the auto-launch crate: an XDG autostart
//! entry (`~/.config/autostart/<app>.desktop`) on Linux, a Launch Agent on
//! macOS, a `Run` registry value on Windows.
//!
//! The entry always starts the program that is running now: on Linux the
//! AppImage only when we really run from it (`$APPIMAGE` is a file and this
//! executable is inside the AppImage's mount, `$APPDIR`), else this
//! executable. While start at login is on, the entry is written again at
//! every start, so a moved or replaced app never leaves a stale `Exec=`.

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use std::path::{Path, PathBuf};

/// The program the entry starts, from this executable and the AppImage
/// runtime's `$APPIMAGE` and `$APPDIR`. Paths are canonicalised by the
/// caller (`canonical`); one that cannot be is not trusted.
pub(crate) fn launch_path(
    exe: &Path,
    appimage: Option<&Path>,
    appdir: Option<&Path>,
    canonical: impl Fn(&Path) -> Option<PathBuf>,
) -> PathBuf {
    let exe = canonical(exe).unwrap_or_else(|| exe.to_path_buf());
    if let (Some(image), Some(dir)) = (appimage, appdir) {
        if let (Some(image), Some(dir)) = (canonical(image), canonical(dir)) {
            // The AppImage itself is not inside its own mount.
            if image.is_absolute() && exe.starts_with(&dir) && !image.starts_with(&dir) {
                return image;
            }
        }
    }
    exe
}

/// Why `path` cannot go into an XDG `Exec=` line as it is (auto-launch does
/// not quote it): whitespace, quotes and the characters the desktop entry
/// spec reserves would run something else or nothing.
pub(crate) fn exec_path_problem(path: &str) -> Option<String> {
    let bad = |c: char| c.is_whitespace() || "\"'\\`$%;&|<>()*?#~".contains(c);
    if path.is_empty() || !path.starts_with('/') {
        return Some(format!("the app's path is not absolute: {path:?}"));
    }
    path.chars()
        .find(|c| bad(*c))
        .map(|c| format!("the app's path has a {c:?}, which a startup entry cannot hold: {path}"))
}

/// The OS entry, or why there is none.
pub(crate) struct AutoStart {
    launch: Result<AutoLaunch, String>,
}

impl AutoStart {
    pub(crate) fn new(app_name: &str) -> Self {
        Self {
            launch: build(app_name),
        }
    }

    fn launch(&self) -> Result<&AutoLaunch, String> {
        self.launch.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn is_enabled(&self) -> Result<bool, String> {
        self.launch()?.is_enabled().map_err(|e| e.to_string())
    }

    pub(crate) fn set(&self, enabled: bool) -> Result<(), String> {
        let launch = self.launch()?;
        let result = if enabled {
            launch.enable()
        } else {
            launch.disable()
        };
        match result {
            // Turning off what is already off (Windows says "not found").
            Err(auto_launch::Error::Io(e))
                if !enabled && e.kind() == std::io::ErrorKind::NotFound =>
            {
                Ok(())
            }
            r => r.map_err(|e| e.to_string()),
        }
    }

    /// On start: when the entry exists, write it again for this program.
    pub(crate) fn refresh(&self) {
        match self.is_enabled() {
            Ok(true) => match self.set(true) {
                Ok(()) => tracing::info!("start at login: entry rewritten for {}", self.path()),
                Err(e) => tracing::warn!("start at login: could not rewrite the entry: {e}"),
            },
            Ok(false) => {}
            Err(e) => tracing::warn!("start at login: could not read the entry: {e}"),
        }
    }

    fn path(&self) -> &str {
        self.launch.as_ref().map(|l| l.get_app_path()).unwrap_or("")
    }
}

fn build(app_name: &str) -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not find the app's path: {e}"))?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let path = if cfg!(target_os = "linux") {
        launch_path(&exe, appimage.as_deref(), appdir.as_deref(), |p| {
            p.canonicalize().ok()
        })
    } else if cfg!(target_os = "macos") {
        exe.canonicalize().unwrap_or(exe)
    } else {
        exe
    };
    let path = path.display().to_string();
    if cfg!(target_os = "linux") {
        if let Some(problem) = exec_path_problem(&path) {
            return Err(problem);
        }
    }
    let mut builder = AutoLaunchBuilder::new();
    builder.set_app_name(app_name).set_app_path(&path);
    #[cfg(target_os = "macos")]
    builder.set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent);
    builder.build().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every path canonicalises to itself (they are already canonical).
    fn same(p: &Path) -> Option<PathBuf> {
        Some(p.to_path_buf())
    }

    const EXE: &str = "/tmp/.mount_nauviX/usr/bin/nauvi-desktop";

    // Unix paths: only Linux uses the AppImage.
    #[cfg(unix)]
    #[test]
    fn the_appimage_when_running_from_it() {
        let got = launch_path(
            Path::new(EXE),
            Some(Path::new("/home/u/Apps/nauvi.AppImage")),
            Some(Path::new("/tmp/.mount_nauviX")),
            same,
        );
        assert_eq!(got, PathBuf::from("/home/u/Apps/nauvi.AppImage"));
    }

    // Unix paths: only Linux uses the AppImage.
    #[cfg(unix)]
    #[test]
    fn an_appimage_we_do_not_run_from_is_ignored() {
        let exe = Path::new("/usr/bin/nauvi-desktop");
        // Inherited from a parent AppImage, or set by hand.
        let got = launch_path(
            exe,
            Some(Path::new("/home/u/other.AppImage")),
            Some(Path::new("/tmp/.mount_other")),
            same,
        );
        assert_eq!(got, exe);
        // No APPDIR: not trusted either.
        assert_eq!(
            launch_path(exe, Some(Path::new("/home/u/x.AppImage")), None, same),
            exe
        );
        // An APPIMAGE inside the mount, or relative.
        let exe = Path::new(EXE);
        let dir = Some(Path::new("/tmp/.mount_nauviX"));
        assert_eq!(
            launch_path(exe, Some(Path::new("/tmp/.mount_nauviX/AppRun")), dir, same),
            exe
        );
        assert_eq!(
            launch_path(exe, Some(Path::new("nauvi.AppImage")), dir, same),
            exe
        );
    }

    // Unix paths: only Linux uses the AppImage.
    #[cfg(unix)]
    #[test]
    fn an_appimage_that_does_not_exist_is_ignored() {
        let exe = Path::new(EXE);
        // `canonicalize` fails for a moved or deleted file.
        let gone = |p: &Path| (!p.ends_with("nauvi.AppImage")).then(|| p.to_path_buf());
        let got = launch_path(
            exe,
            Some(Path::new("/home/u/nauvi.AppImage")),
            Some(Path::new("/tmp/.mount_nauviX")),
            gone,
        );
        assert_eq!(got, exe);
    }

    #[test]
    fn exec_paths_that_need_quoting_are_refused() {
        assert_eq!(exec_path_problem("/usr/bin/nauvi-desktop"), None);
        assert_eq!(
            exec_path_problem("/home/u/Apps/nauvi_0.1.0-x86_64.AppImage"),
            None
        );
        assert!(exec_path_problem("/home/u/My Apps/nauvi.AppImage").is_some());
        assert!(exec_path_problem("/home/u/a;rm/nauvi").is_some());
        assert!(exec_path_problem("/home/u/%f/nauvi").is_some());
        assert!(exec_path_problem("relative/nauvi").is_some());
    }
}
