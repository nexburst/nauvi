//! Scanning an image with a Trivy or Grype the user installed (#536, ADR
//! 0011). A separate opt-in next to the Trivy Operator's reports.
//!
//! - **nauvi never downloads a scanner or a vulnerability database.** The
//!   binary is `NAUVI_TRIVY` / `NAUVI_GRYPE` when set (an absolute path),
//!   else the first `trivy` / `grype` in an absolute `PATH` entry. The app
//!   runs it only on a path the user approved, by its [`Fingerprint`]: a
//!   changed binary is a new question. Known malicious releases are
//!   refused before anything of the binary runs, from the Go build info
//!   in the file ([`refused_build`]: for Trivy and Grype alike, a file
//!   whose build info names a malicious Trivy or another program's module;
//!   a Trivy whose file names no version is refused too), and again by
//!   the version it prints ([`refused_version`]).
//! - **The image reference comes from the cluster and is untrusted.**
//!   [`scan_target`] parses it with [`ImageRef`] (only the characters the
//!   distribution spec allows), refuses registries on this machine,
//!   link-local addresses and metadata endpoints ([`check_host`]), and
//!   rebuilds it as `registry/repository@sha256:…` from the parsed parts:
//!   the scan is by the digest the pod runs. It is one argv item after
//!   `--`, never through a shell. Before the scanner starts, the
//!   registry's name is resolved and refused when any address it has is
//!   one of those ([`check_target_resolves`]); best effort, as the scanner
//!   resolves it again itself.
//! - **One scan is one child process** with a timeout, killed when the
//!   future is dropped (cancel), its stdout capped at [`MAX_OUTPUT`] and
//!   its stderr at [`MAX_STDERR`] (the tail is kept). It runs in a folder
//!   of nauvi's own, so no `trivy.yaml` / `.grype.yaml` of the current
//!   folder applies.
//! - The scanner uses the user's own docker config for credentials; nauvi
//!   never reads `imagePullSecrets`.

use super::go_buildinfo::{BuildInfo, Finder};
use super::{grype_json, trivy_json, Vulnerability};
use crate::registry_tags::{check_host, ImageRef, DOCKER_HUB};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// The most a scanner may print on stdout (its JSON report).
pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;
/// How much of its stderr is kept (the end of it).
pub const MAX_STDERR: usize = 256 * 1024;
/// Give up on one scan after this long.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long the rest of its stderr is awaited once the scanner exited.
const STDERR_GRACE: Duration = Duration::from_secs(5);
/// Give up on `version` after this long.
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

/// Which scanner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum ScannerKind {
    #[default]
    Trivy,
    Grype,
}

impl ScannerKind {
    /// The program's name on `PATH`.
    pub fn binary(self) -> &'static str {
        match self {
            ScannerKind::Trivy => "trivy",
            ScannerKind::Grype => "grype",
        }
    }

    /// The variable that names its path instead.
    pub fn env_var(self) -> &'static str {
        match self {
            ScannerKind::Trivy => "NAUVI_TRIVY",
            ScannerKind::Grype => "NAUVI_GRYPE",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ScannerKind::Trivy => "Trivy",
            ScannerKind::Grype => "Grype",
        }
    }

    fn install_page(self) -> &'static str {
        match self {
            ScannerKind::Trivy => "https://trivy.dev/latest/getting-started/installation/",
            ScannerKind::Grype => "https://github.com/anchore/grype#installation",
        }
    }
}

/// Why there is no scanner to run.
pub fn not_installed(kind: ScannerKind) -> String {
    format!(
        "{} is not installed or not on PATH. Install it yourself ({}), or set {} to its path: \
         nauvi never downloads a scanner.",
        kind.binary(),
        kind.install_page(),
        kind.env_var()
    )
}

/// Where the scanner is: `NAUVI_TRIVY` (or `NAUVI_GRYPE`) when set, else
/// the first one on `PATH`. The path has its links resolved.
pub fn find_binary(kind: ScannerKind) -> Result<PathBuf, String> {
    find_in(
        kind,
        std::env::var_os(kind.env_var()),
        std::env::var_os("PATH"),
    )
}

/// [`find_binary`] with the variables given. Relative `PATH` entries (and
/// `.`) are skipped: they would run whatever the current folder holds.
pub fn find_in(
    kind: ScannerKind,
    explicit: Option<OsString>,
    path: Option<OsString>,
) -> Result<PathBuf, String> {
    if let Some(p) = explicit.filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        if !p.is_absolute() {
            return Err(format!(
                "{} must be an absolute path, not {}.",
                kind.env_var(),
                p.display()
            ));
        }
        if !is_executable_file(&p) {
            return Err(format!(
                "{} names {}, which is not an executable file.",
                kind.env_var(),
                p.display()
            ));
        }
        return p
            .canonicalize()
            .map_err(|e| format!("Cannot read {}: {e}", p.display()));
    }
    find_on_path(kind.binary(), path).ok_or_else(|| not_installed(kind))
}

/// The first executable `program` (`program.exe` on Windows) in an
/// absolute entry of `path`, its links resolved. Relative entries (and
/// `.`) are skipped: they would run whatever the current folder holds.
pub fn find_on_path(program: &str, path: Option<OsString>) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    };
    std::env::split_paths(&path.unwrap_or_default())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(&name))
        .filter(|candidate| is_executable_file(candidate))
        .find_map(|candidate| candidate.canonicalize().ok())
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
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

/// What identifies one binary: the user approves this, and a binary that
/// changed (another path, size, time or content) is asked about again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Fingerprint {
    pub path: String,
    pub size: u64,
    /// Last modified, unix seconds.
    pub modified: i64,
    /// Hex SHA-256 of the file.
    pub sha256: String,
}

/// [`Fingerprint`] of `path` (reads the whole file: call it off the async
/// threads).
pub fn fingerprint(path: &Path) -> std::io::Result<Fingerprint> {
    inspect(path).map(|(fp, _)| fp)
}

/// [`Fingerprint`] of `path` and the Go build info in it, from one read
/// of the file (never running it): what [`refused_build`] looks at.
pub fn inspect(path: &Path) -> std::io::Result<(Fingerprint, Option<BuildInfo>)> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut finder = Finder::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        finder.feed(&buf[..n]);
    }
    let sha256 = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let fp = Fingerprint {
        path: path.display().to_string(),
        size: meta.len(),
        modified,
        sha256,
    };
    Ok((fp, finder.finish()))
}

/// `0.58.1`, `v0.58.1`, `0.58.1-rc1` as numbers.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut parts = s.splitn(3, '.');
    let num = |p: &str| -> Option<u64> {
        let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let major = num(parts.next()?)?;
    let minor = num(parts.next()?)?;
    let patch = num(parts.next().unwrap_or("0"))?;
    Some((major, minor, patch))
}

/// Trivy 0.69.4 to 0.69.6 were malicious releases published with stolen
/// credentials (CVE-2026-33634).
fn malicious_trivy(v: (u64, u64, u64)) -> Option<String> {
    ((0, 69, 4)..=(0, 69, 6)).contains(&v).then(|| {
        format!(
            "Trivy {}.{}.{} is one of the malicious releases (0.69.4 to 0.69.6, CVE-2026-33634): \
             nauvi does not run it. Install another version, and rotate the credentials it could \
             read on this computer.",
            v.0, v.1, v.2
        )
    })
}

/// Why nauvi does not run this version (`None`: it may), as the scanner
/// says it once run. A version nauvi cannot read is refused too.
pub fn refused_version(kind: ScannerKind, version: &str) -> Option<String> {
    let Some(v) = parse_version(version) else {
        return Some(format!(
            "Cannot tell which version of {} this is ({:?}), so nauvi does not run it.",
            kind.label(),
            crate::text::single_line(version)
        ));
    };
    if kind == ScannerKind::Trivy {
        return malicious_trivy(v);
    }
    None
}

/// The module of Trivy's releases, and the variable its release builds
/// set to their version (`-ldflags -X`).
pub const TRIVY_MODULE: &str = "github.com/aquasecurity/trivy";
pub const TRIVY_VERSION_VAR: &str = "github.com/aquasecurity/trivy/pkg/version/app.ver";
/// Where old Trivy releases (0.26 and before) set it.
const OLD_TRIVY_VERSION_VAR: &str = "main.version";

/// Why nauvi does not run this binary, from its file alone (before anything
/// of it runs). Trivy 0.69.4 to 0.69.6 ran their payload as soon as they
/// started, even for `version`, so nauvi must know a Trivy's version from
/// its Go build info (`info`; `None` when the file has none it can read)
/// before it asks the binary:
///
/// - a module version, or a version the build set (`-ldflags -X`), that is
///   a malicious release is refused;
/// - when the build info names no version (Homebrew builds Trivy with
///   `-trimpath`, which leaves `-ldflags` out of it), the version is taken
///   from `path` (resolved, links followed) when that is a Homebrew Cellar
///   or Nix store folder ([`store_path`](super::store_path)), and checked
///   the same way;
/// - anything else with no version (a `(devel)` build under `-trimpath`
///   elsewhere, a packed binary, a script around it) is refused: nauvi
///   cannot tell it from a malicious one without running it (#561).
///
/// For any scanner, first (#573): a file whose build info names a
/// malicious Trivy is refused, and so is one whose main module is not the
/// scanner's ([`module_of`]): a malicious Trivy installed as `grype` (or
/// named by `NAUVI_GRYPE`) never runs, not even for `grype version`.
/// Grype has no known malicious release, so a Grype with no build info
/// nauvi can read, or none naming a module, is left to what it prints.
///
/// `None`: it may run, and the version it prints is checked too, by
/// [`refused_version`].
pub fn refused_build(kind: ScannerKind, info: Option<&BuildInfo>, path: &Path) -> Option<String> {
    if let Some(info) = info {
        if let Some(why) = trivy_build_versions(info)
            .into_iter()
            .find_map(malicious_trivy)
        {
            return Some(why);
        }
        if !info.main_module.is_empty() && info.main_module != module_of(kind) {
            return Some(format!(
                "This file is not {}: its Go build info names the module {} ({}'s is {}), so \
                 nauvi does not run it. Set {} to the {} you installed.",
                kind.label(),
                crate::text::single_line(&info.main_module),
                kind.label(),
                module_of(kind),
                kind.env_var(),
                kind.label(),
            ));
        }
    }
    if kind != ScannerKind::Trivy {
        return None;
    }
    match trivy_file_version(info, path) {
        FileVersion::Built(versions) => versions.into_iter().find_map(malicious_trivy),
        FileVersion::Store(v, store) => malicious_trivy(v)
            .map(|why| format!("{why} (nauvi read its version from {}.)", store.place())),
        FileVersion::NoInfo => Some(format!(
            "nauvi finds no Go build info in this file (a packed binary, or a script around \
             Trivy?), so it cannot tell which version of Trivy this is without running it. \
             {UNVERSIONED_TRIVY}"
        )),
        FileVersion::NoVersion => Some(format!(
            "This Trivy's Go build info names no version (built from source?), so nauvi cannot \
             tell which version it is without running it. {UNVERSIONED_TRIVY} Or build it \
             without -trimpath and with -ldflags \"-X {TRIVY_VERSION_VAR}=<version>\"."
        )),
    }
}

/// Where nauvi read a Trivy's version, when not from its build info:
/// `Version 0.58.1 from its Homebrew folder.` (`None` otherwise).
pub fn file_version_note(
    kind: ScannerKind,
    info: Option<&BuildInfo>,
    path: &Path,
) -> Option<String> {
    if kind != ScannerKind::Trivy {
        return None;
    }
    match trivy_file_version(info, path) {
        FileVersion::Store(v, store) => Some(format!(
            "Version {}.{}.{} from {}.",
            v.0,
            v.1,
            v.2,
            store.place()
        )),
        _ => None,
    }
}

/// What a Trivy's file says of its version.
enum FileVersion {
    /// From its build info (module, `-X`): all of them.
    Built(Vec<(u64, u64, u64)>),
    /// None in its build info; from the package manager's folder.
    Store((u64, u64, u64), super::store_path::Store),
    /// No build info nauvi can read.
    NoInfo,
    /// Build info without a version, not in a package manager's folder.
    NoVersion,
}

/// The module of Grype's releases (`github.com/anchore/grype/cmd/grype`).
pub const GRYPE_MODULE: &str = "github.com/anchore/grype";

/// The main module a scanner's Go build info names.
pub fn module_of(kind: ScannerKind) -> &'static str {
    match kind {
        ScannerKind::Trivy => TRIVY_MODULE,
        ScannerKind::Grype => GRYPE_MODULE,
    }
}

/// The Trivy versions a file's build info names, whatever it was found
/// as: its module's version when that is Trivy's, and the version a
/// Trivy build sets (`-X …/app.ver`; `-X main.version` only in Trivy's
/// own module, as any program may set that one).
fn trivy_build_versions(info: &BuildInfo) -> Vec<(u64, u64, u64)> {
    let trivy = info.main_module == TRIVY_MODULE;
    trivy
        .then_some(info.main_version.as_str())
        .into_iter()
        .chain(info.x(TRIVY_VERSION_VAR))
        .chain(info.x(OLD_TRIVY_VERSION_VAR).filter(|_| trivy))
        .filter_map(parse_version)
        .collect()
}

fn trivy_file_version(info: Option<&BuildInfo>, path: &Path) -> FileVersion {
    let versions: Vec<_> = info
        .map(|info| {
            let mut v = trivy_build_versions(info);
            // Trivy 0.26 and before: `-X main.version`, no module.
            if info.main_module.is_empty() {
                v.extend(info.x(OLD_TRIVY_VERSION_VAR).and_then(parse_version));
            }
            v
        })
        .unwrap_or_default();
    if !versions.is_empty() {
        return FileVersion::Built(versions);
    }
    // Only a Go binary of Trivy's module: a script, a packed file or
    // another program in a Cellar is not what Homebrew built.
    if let Some(info) = info {
        if info.main_module != TRIVY_MODULE {
            return FileVersion::NoVersion;
        }
        if let Some((v, store)) =
            super::store_path::version_from_path(path, ScannerKind::Trivy.binary())
        {
            if let Some(v) = parse_version(&v) {
                return FileVersion::Store(v, store);
            }
        }
        return FileVersion::NoVersion;
    }
    FileVersion::NoInfo
}

/// Why a Trivy of unknown version does not run, and what to do instead.
/// Trivy's own release builds name their version (module and `-X`).
const UNVERSIONED_TRIVY: &str = "nauvi does not run it: Trivy 0.69.4 to 0.69.6 ran malicious \
     code as soon as they started (CVE-2026-33634). Install a release build of Trivy (from its \
     GitHub releases, its apt or yum repository, Homebrew or Nix), or set NAUVI_TRIVY to one.";

/// The scanner's version and its vulnerability database's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScannerVersion {
    /// `0.58.1`.
    pub version: String,
    /// When its vulnerability database was built (as the scanner says it),
    /// empty when it has none yet.
    pub db: String,
}

/// Ask the scanner at `path` its version (`trivy version --format json`,
/// `grype version -o json` and `grype db status -o json`). Neither
/// downloads anything.
pub async fn scanner_version(
    kind: ScannerKind,
    path: &Path,
    work_dir: &Path,
) -> Result<ScannerVersion> {
    let run = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        async move {
            run_capped(
                path,
                &args,
                work_dir,
                &env_of(kind, &ScanOptions::default()),
                1024 * 1024,
                VERSION_TIMEOUT,
            )
            .await
        }
    };
    match kind {
        ScannerKind::Trivy => {
            let out = run(&["version", "--format", "json"])
                .await
                .map_err(|e| anyhow!("{} version failed: {}", kind.binary(), e.message()))?;
            trivy_json::parse_version(&out.stdout)
                .map_err(|e| anyhow!("Cannot read the output of trivy version: {e}"))
        }
        ScannerKind::Grype => {
            let out = run(&["version", "-o", "json"])
                .await
                .map_err(|e| anyhow!("{} version failed: {}", kind.binary(), e.message()))?;
            let mut v = grype_json::parse_version(&out.stdout)
                .map_err(|e| anyhow!("Cannot read the output of grype version: {e}"))?;
            if let Ok(out) = run(&["db", "status", "-o", "json"]).await {
                v.db = grype_json::parse_db_status(&out.stdout);
            }
            // Older Grype prints its status only as text (`Built: …`).
            if v.db.is_empty() {
                if let Ok(out) = run(&["db", "status"]).await {
                    v.db = grype_json::parse_db_status_text(&out.stdout);
                }
            }
            Ok(v)
        }
    }
}

/// What one scan looks at: an image by digest, on one platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanTarget {
    /// `docker.io/library/nginx@sha256:…`, rebuilt from the parsed parts.
    pub reference: String,
    /// `docker.io`, `ghcr.io`, `registry.example.com:5000`.
    pub registry: String,
    pub digest: String,
    /// `linux/amd64`, empty for the scanner's default.
    pub platform: String,
}

/// `sha256:` and 64 lower-case hex digits.
pub fn is_digest(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// The scan of `image` (a pod's reference) at `digest` (from the pod's
/// `imageID`) for `platform`. Everything here came from the cluster.
pub fn scan_target(image: &str, digest: &str, platform: &str) -> Result<ScanTarget, String> {
    if image.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("The image name has spaces or control characters: not scanned.".into());
    }
    let r = ImageRef::parse(image)?;
    if digest.is_empty() {
        return Err(format!(
            "No pod reports which digest of {} it runs (has it started?): nauvi scans images \
             by digest only.",
            r.shown()
        ));
    }
    if !is_digest(digest) {
        return Err(format!(
            "{} runs a digest that is not sha256:<64 hex digits>: not scanned.",
            r.shown()
        ));
    }
    if r.registry != DOCKER_HUB {
        check_host(&r.registry, false)?;
    }
    check_platform(platform)?;
    let reference = format!("{}/{}@{}", r.registry, r.repository, digest);
    // The parts allow nothing else; checked again since this goes to argv.
    let safe = reference.bytes().all(|b| {
        b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || matches!(b, b'.' | b'_' | b'-' | b'/' | b':' | b'@' | b'[' | b']')
    });
    if !safe || reference.starts_with('-') {
        return Err(format!("{} is not a reference nauvi scans.", r.shown()));
    }
    Ok(ScanTarget {
        reference,
        registry: r.registry,
        digest: digest.to_string(),
        platform: platform.to_string(),
    })
}

/// Resolve `target`'s registry and refuse it when any of its addresses is
/// on this machine, link-local or a metadata endpoint (#572): the scanner
/// connects to it with the user's credentials. Call it right before the
/// scanner starts. Best effort: the scanner resolves the name again.
pub async fn check_target_resolves(target: &ScanTarget) -> Result<(), String> {
    check_target_resolves_with(target, crate::registry_tags::system_resolve).await
}

/// [`check_target_resolves`] with the resolver given (tests).
pub async fn check_target_resolves_with<R, F>(target: &ScanTarget, resolve: R) -> Result<(), String>
where
    R: FnOnce(String) -> F,
    F: std::future::Future<Output = std::io::Result<Vec<std::net::IpAddr>>>,
{
    if target.registry == DOCKER_HUB {
        return Ok(());
    }
    crate::registry_tags::check_resolved(&target.registry, false, resolve).await
}

/// `os/arch` or `os/arch/variant` (each `[a-z0-9_]`, at most 32), or empty.
pub fn check_platform(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Ok(());
    }
    let parts: Vec<&str> = p.split('/').collect();
    let ok = (2..=3).contains(&parts.len())
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.len() <= 32
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{:?} is not a platform (os/arch).",
            crate::text::single_line(p)
        ))
    }
}

/// The user's options for the scanner (Settings → Image security).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanOptions {
    /// Trivy's `--db-repository` (an OCI repository), empty for its default.
    pub db_repository: String,
    /// Do not let the scanner update its database (Trivy's
    /// `--skip-db-update`, Grype's `GRYPE_DB_AUTO_UPDATE=false`).
    pub skip_db_update: bool,
    /// A Trivy server (`--server`), empty to scan here.
    pub server_url: String,
}

/// Whether `o` may be passed to `kind`, saying what is wrong.
pub fn check_options(kind: ScannerKind, o: &ScanOptions) -> Result<(), String> {
    let db = o.db_repository.trim();
    if !db.is_empty() {
        if kind != ScannerKind::Trivy {
            return Err("A database repository is a Trivy option; Grype has none.".into());
        }
        let r = ImageRef::parse(db).map_err(|e| format!("The database repository: {e}"))?;
        if r.registry != DOCKER_HUB {
            check_host(&r.registry, false).map_err(|e| format!("The database repository: {e}"))?;
        }
    }
    let server = o.server_url.trim();
    if !server.is_empty() {
        if kind != ScannerKind::Trivy {
            return Err("A scan server is a Trivy option; Grype has none.".into());
        }
        let bad = || format!("{server:?} is not an http(s) URL of a Trivy server.");
        if server.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(bad());
        }
        let uri: http::Uri = server.parse().map_err(|_| bad())?;
        let ok = matches!(uri.scheme_str(), Some("http") | Some("https"))
            && uri
                .authority()
                .is_some_and(|a| !a.as_str().contains('@') && !a.host().is_empty());
        if !ok {
            return Err(bad());
        }
    }
    Ok(())
}

/// The arguments of one scan. Options take their value in the same item
/// (`--platform=linux/amd64`), and the reference comes last, after `--`.
pub fn scan_args(
    kind: ScannerKind,
    version: &str,
    target: &ScanTarget,
    o: &ScanOptions,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    match kind {
        ScannerKind::Trivy => {
            // From the registry (like Grype), not a local daemon's copy.
            args.extend(
                [
                    "image",
                    "--format=json",
                    "--quiet",
                    "--scanners=vuln",
                    "--image-src=remote",
                ]
                .map(String::from),
            );
            // The version check phones home. Trivy skips it only with
            // telemetry off as well (`TRIVY_DISABLE_TELEMETRY`, see
            // `env_of`); 0.54 added this switch.
            if parse_version(version).is_some_and(|v| v >= (0, 54, 0)) {
                args.push("--skip-version-check".into());
            }
            if !target.platform.is_empty() {
                args.push(format!("--platform={}", target.platform));
            }
            let server = o.server_url.trim();
            if !server.is_empty() {
                args.push(format!("--server={server}"));
            } else {
                let db = o.db_repository.trim();
                if !db.is_empty() {
                    args.push(format!("--db-repository={db}"));
                }
                if o.skip_db_update {
                    args.push("--skip-db-update".into());
                    args.push("--skip-java-db-update".into());
                }
            }
            args.push("--".into());
            args.push(target.reference.clone());
        }
        ScannerKind::Grype => {
            args.extend(["--output=json", "--quiet"].map(String::from));
            if !target.platform.is_empty() {
                args.push(format!("--platform={}", target.platform));
            }
            args.push("--".into());
            // From the registry, not a local daemon's copy.
            args.push(format!("registry:{}", target.reference));
        }
    }
    args
}

/// The environment added for the scanner (also for `version`): no update
/// check and no telemetry, and Grype's database left alone when asked.
/// Trivy sends its version check (with a `Trivy-Identifier`) unless both
/// the check is skipped and telemetry is off; an older Trivy ignores the
/// variables it does not know.
pub(crate) fn env_of(kind: ScannerKind, o: &ScanOptions) -> Vec<(String, String)> {
    match kind {
        ScannerKind::Trivy => vec![
            ("TRIVY_DISABLE_TELEMETRY".into(), "true".into()),
            ("TRIVY_SKIP_VERSION_CHECK".into(), "true".into()),
        ],
        ScannerKind::Grype => {
            let mut env = vec![("GRYPE_CHECK_FOR_APP_UPDATE".into(), "false".into())];
            if o.skip_db_update {
                env.push(("GRYPE_DB_AUTO_UPDATE".into(), "false".into()));
            }
            env
        }
    }
}

/// What a finished child printed.
#[derive(Debug, Default)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Why a run failed.
#[derive(Debug)]
pub enum RunError {
    /// The program is not there (any more).
    NotFound,
    /// It exited unsuccessfully: its status and the end of its stderr.
    Failed {
        status: String,
        stderr: String,
    },
    /// Its stdout passed the cap.
    TooLarge(usize),
    TimedOut(Duration),
    Io(std::io::Error),
}

impl RunError {
    pub fn message(&self) -> String {
        match self {
            RunError::NotFound => "the program is not there any more".into(),
            RunError::Failed { status, stderr } => {
                let last = last_error_line(stderr);
                if last.is_empty() {
                    format!("it exited with {status}")
                } else {
                    last
                }
            }
            RunError::TooLarge(n) => {
                format!(
                    "it printed more than {} MB, so it was stopped",
                    n / (1024 * 1024)
                )
            }
            RunError::TimedOut(d) => format!("it did not finish within {} s", d.as_secs()),
            RunError::Io(e) => e.to_string(),
        }
    }
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut r: R,
    limit: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Ok(Some(buf));
        }
        if buf.len() + n > limit {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// The last `limit` bytes `r` gives.
async fn read_tail<R: AsyncRead + Unpin>(mut r: R, limit: usize) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    while let Ok(n) = r.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > limit {
            let cut = buf.len() - limit;
            buf.drain(..cut);
        }
    }
    buf
}

/// Kills the scanner's process group (on Unix: the child and whatever it
/// started) when dropped while armed: a cancelled, timed out or too
/// chatty scan. Dropped before the child is reaped, so the group id is
/// still the child's.
struct Group {
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    armed: bool,
}

impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.armed {
            if let Some(pgid) = self.pid.and_then(|p| libc::pid_t::try_from(p).ok()) {
                // SAFETY: plain syscall on the child's own group (started
                // with `process_group(0)`, not reaped yet).
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
            }
        }
    }
}

/// Run `program` with `args` (no shell, stdin closed) in `work_dir`, with
/// `env` added. Its stdout is capped at `limit`, its stderr's tail at
/// [`MAX_STDERR`]. The child (and on Unix its process group) is killed on
/// timeout, on a too large output, and when the returned future is
/// dropped.
pub async fn run_capped(
    program: &Path,
    args: &[String],
    work_dir: &Path,
    env: &[(String, String)],
    limit: usize,
    timeout: Duration,
) -> Result<Output, RunError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let run = async {
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => RunError::NotFound,
            _ => RunError::Io(e),
        })?;
        let group = Group {
            pid: child.id(),
            armed: true,
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RunError::Io(std::io::Error::other("no stdout pipe")))?;
        let stderr = child.stderr.take();
        let err_task = tokio::spawn(async move {
            match stderr {
                Some(s) => read_tail(s, MAX_STDERR).await,
                None => Vec::new(),
            }
        });
        let out = read_capped(stdout, limit).await.map_err(RunError::Io)?;
        let Some(stdout) = out else {
            drop(group);
            let _ = child.start_kill();
            let _ = child.wait().await;
            err_task.abort();
            return Err(RunError::TooLarge(limit));
        };
        let status = child.wait().await.map_err(RunError::Io)?;
        // Its stderr ends when every process holding it is gone. One it
        // started may still hold it: wait briefly, then kill the group.
        // The group id is still in use while such a process lives, so it
        // cannot name another process's group. The group stays armed until
        // then, so the overall timeout (or a cancel) kills it too.
        let mut err_task = err_task;
        let tail = match tokio::time::timeout(STDERR_GRACE, &mut err_task).await {
            Ok(r) => {
                let mut group = group;
                group.armed = false;
                r.unwrap_or_default()
            }
            Err(_) => {
                drop(group);
                err_task.abort();
                Vec::new()
            }
        };
        let stderr = String::from_utf8_lossy(&tail).into_owned();
        if !status.success() {
            return Err(RunError::Failed {
                status: status.to_string(),
                stderr,
            });
        }
        Ok(Output { stdout, stderr })
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(r) => r,
        Err(_) => Err(RunError::TimedOut(timeout)),
    }
}

/// The scanner's last error line, without its time and level columns
/// (`2026-…\tFATAL\tFatal error\t…`), on one line, at most 600 characters.
fn last_error_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let line = lines
        .iter()
        .rev()
        .find(|l| {
            let u = l.to_ascii_uppercase();
            u.contains("FATAL") || u.contains("ERROR")
        })
        .or(lines.last())
        .copied()
        .unwrap_or("");
    let mut text = line;
    for level in ["FATAL", "ERROR"] {
        if let Some(i) = text.find(level) {
            text = &text[i + level.len()..];
        }
    }
    let text = crate::text::single_line(text.trim_start_matches([':', ' ', '\t']));
    let text = text
        .strip_prefix("Fatal error ")
        .unwrap_or(&text)
        .to_string();
    text.chars().take(600).collect()
}

/// A failed scan in plain words: a registry this computer cannot reach, a
/// pull that was not allowed, a digest the registry does not have, a
/// database that is missing while updates are off; else the scanner's own
/// last error line.
pub fn failure_text(kind: ScannerKind, e: &RunError, target: &ScanTarget) -> String {
    let name = kind.label();
    let RunError::Failed { stderr, .. } = e else {
        return format!(
            "{name} could not scan {}: {}.",
            target.reference,
            e.message()
        );
    };
    let last = e.message();
    let lower = stderr.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    let registry = &target.registry;
    if has(&[
        "first run cannot skip",
        "--skip-db-update cannot be specified",
        "database not found",
        "db not found",
    ]) {
        return format!(
            "{name} has no vulnerability database yet and \"Do not update the database\" is on. \
             Download it yourself once (trivy image --download-db-only, or grype db update), or \
             turn the option off. ({last})"
        );
    }
    if has(&[
        "no such host",
        "connection refused",
        "i/o timeout",
        "network is unreachable",
        "tls handshake timeout",
        "context deadline exceeded",
        "dial tcp",
        "no route to host",
    ]) {
        return format!(
            "This computer cannot reach the registry {registry}. The scanner runs here, not in \
             the cluster: check the network, VPN or proxy. ({last})"
        );
    }
    if has(&[
        "unauthorized",
        "authentication required",
        "denied: ",
        "access denied",
        "401",
        "403 forbidden",
    ]) {
        return format!(
            "The registry {registry} did not let {name} pull the image. The scanner uses your \
             own docker login on this computer (docker login {registry}); nauvi does not use \
             the cluster's pull secrets. ({last})"
        );
    }
    if has(&["manifest unknown", "manifest_unknown", "not found"]) {
        return format!(
            "The registry {registry} has no image {}: it may have been deleted, or the node \
             runs a copy that was never pushed there. ({last})",
            target.reference
        );
    }
    format!("{name} could not scan {}: {last}", target.reference)
}

/// Scan `target` with the scanner at `path` (of `version`), in `work_dir`.
/// Dropping the future stops the scanner.
pub async fn scan(
    kind: ScannerKind,
    path: &Path,
    version: &str,
    target: &ScanTarget,
    o: &ScanOptions,
    work_dir: &Path,
) -> Result<Vec<Vulnerability>> {
    if let Some(why) = refused_version(kind, version) {
        bail!(why);
    }
    check_options(kind, o).map_err(|e| anyhow!(e))?;
    let args = scan_args(kind, version, target, o);
    let out = run_capped(
        path,
        &args,
        work_dir,
        &env_of(kind, o),
        MAX_OUTPUT,
        SCAN_TIMEOUT,
    )
    .await
    .map_err(|e| match e {
        RunError::NotFound => anyhow!(not_installed(kind)),
        e => anyhow!(failure_text(kind, &e, target)),
    })?;
    let parsed = match kind {
        ScannerKind::Trivy => trivy_json::parse_scan(&out.stdout),
        ScannerKind::Grype => grype_json::parse_scan(&out.stdout),
    };
    parsed.map_err(|e| anyhow!("Cannot read {}'s report: {e}", kind.label()))
}

#[cfg(test)]
mod tests;
