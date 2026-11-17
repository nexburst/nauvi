//! A kubectl that matches a cluster's version, for the desktop app's local
//! terminal (#331), as Lens has.
//!
//! kubectl supports API servers one minor version older or newer than
//! itself. When the user's kubectl is further away from the cluster (or
//! missing), the app offers to download the matching release from
//! `dl.k8s.io`. Nothing here downloads on its own: the app calls
//! [`download`] only after the user's click.
//!
//! What keeps it safe:
//! - Only `https://dl.k8s.io` ([`DownloadBase::official`]); the fetcher
//!   refuses plain http and redirects to other hosts.
//! - The binary's SHA-256 must equal the `.sha256` file dl.k8s.io publishes
//!   next to it, fetched over https from the same host. A mismatch is
//!   refused and nothing is saved. The checksum comes from dl.k8s.io
//!   itself, so it catches a corrupted or truncated download (or a
//!   tampering CDN cache), **not** a compromised dl.k8s.io: whoever controls
//!   that host controls both files. Kubernetes' release signatures are not
//!   checked.
//! - The checksum is saved next to the binary (`kubectl.sha256`) and
//!   checked by [`installed`] before every use; a binary that no longer
//!   matches (or has no saved checksum) is deleted and offered again.
//! - Version strings come from the API server, so they are parsed into
//!   numbers ([`KubeVersion`]) and only those numbers go into URLs and
//!   paths: a server cannot point the download elsewhere or write outside
//!   the app's data dir.
//! - The binary is written to a private temp file next to its final name,
//!   synced, then renamed into place: a half-written kubectl is never run.
//!   It is then made read-only and executable for its owner (0500).
//! - It is only ever put first on `PATH` in the environment of one local
//!   terminal ([`path_with_first`]); the user's own kubectl is not touched.

use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The only host kubectl is downloaded from.
pub const OFFICIAL_HOST: &str = "dl.k8s.io";

/// The most a kubectl binary may be (they are about 50-60 MB).
pub const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;

/// The most a `.sha256` file may be (it is 64 hex digits).
pub const MAX_CHECKSUM_BYTES: u64 = 1024;

/// A Kubernetes release, `v<major>.<minor>.<patch>`, as numbers only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct KubeVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl KubeVersion {
    /// The release of a `gitVersion` as the API server or kubectl reports
    /// it: `v1.31.2`, `v1.31.2+k3s1`, `v1.30.5-eks-ce1d5eb`. A vendor
    /// suffix is dropped (their kubectl is the upstream one). Anything
    /// that does not start with `v1.<minor>.<patch>` is refused.
    pub fn parse(git_version: &str) -> Result<Self, String> {
        let shown: String = git_version.chars().take(64).collect();
        let bad = || format!("Not a Kubernetes version: {shown:?}.");
        let rest = git_version.trim().strip_prefix('v').ok_or_else(bad)?;
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        let (numbers, suffix) = rest.split_at(end);
        if !(suffix.is_empty() || suffix.starts_with('+') || suffix.starts_with('-')) {
            return Err(bad());
        }
        let parts: Vec<&str> = numbers.split('.').collect();
        let [major, minor, patch] = parts.as_slice() else {
            return Err(bad());
        };
        let num = |s: &str| -> Result<u32, String> {
            // No empty parts, no leading zeros, at most 3 digits.
            if s.is_empty() || s.len() > 3 || (s.len() > 1 && s.starts_with('0')) {
                return Err(bad());
            }
            s.parse().map_err(|_| bad())
        };
        let v = KubeVersion {
            major: num(major)?,
            minor: num(minor)?,
            patch: num(patch)?,
        };
        if v.major != 1 {
            return Err(format!(
                "Kubernetes {shown} is not a 1.x release; there is no kubectl to download for it."
            ));
        }
        Ok(v)
    }

    /// The release tag, `v1.31.2`. Only digits and dots.
    pub fn tag(&self) -> String {
        format!("v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl fmt::Display for KubeVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tag())
    }
}

/// Whether kubectl `client` (`None`: none installed) is outside the
/// supported skew of `server`: more than one minor version away, or
/// another major version.
pub fn skew_too_large(client: Option<&KubeVersion>, server: &KubeVersion) -> bool {
    match client {
        None => true,
        Some(c) => c.major != server.major || c.minor.abs_diff(server.minor) > 1,
    }
}

/// The version in `kubectl version --client -o json`'s output.
pub fn parse_client_version(json: &str) -> Option<KubeVersion> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let git = v.get("clientVersion")?.get("gitVersion")?.as_str()?;
    KubeVersion::parse(git).ok()
}

/// The version of `kubectl` (a name looked up on `PATH`, or a path), or
/// `None` if it does not run or says something else. Waits at most 10 s.
pub async fn kubectl_version(kubectl: &OsStr) -> Option<KubeVersion> {
    let mut cmd = tokio::process::Command::new(kubectl);
    cmd.args(["version", "--client", "-o", "json"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    parse_client_version(&String::from_utf8_lossy(&out.stdout))
}

/// An OS and CPU kubectl is released for, as dl.k8s.io names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
}

impl Platform {
    /// The platform of `os` and `arch` as Rust names them
    /// (`std::env::consts`).
    pub fn of(os: &str, arch: &str) -> Result<Self, String> {
        let os = match os {
            "linux" => "linux",
            "macos" => "darwin",
            "windows" => "windows",
            other => return Err(format!("kubectl is not released for {other}.")),
        };
        let arch = match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => {
                return Err(format!(
                    "kubectl downloads are not offered for {other} CPUs."
                ))
            }
        };
        Ok(Platform { os, arch })
    }

    /// This machine's platform.
    pub fn current() -> Result<Self, String> {
        Self::of(std::env::consts::OS, std::env::consts::ARCH)
    }

    /// `kubectl`, or `kubectl.exe` on Windows.
    pub fn binary_name(&self) -> &'static str {
        if self.os == "windows" {
            "kubectl.exe"
        } else {
            "kubectl"
        }
    }
}

/// Where kubectl is downloaded from: `https://dl.k8s.io`, or (debug builds
/// only, for tests) another `https://` host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadBase {
    /// `https://host[:port]`, no trailing slash.
    origin: String,
    host: String,
}

impl DownloadBase {
    pub fn official() -> Self {
        DownloadBase {
            origin: format!("https://{OFFICIAL_HOST}"),
            host: OFFICIAL_HOST.to_string(),
        }
    }

    /// An `https://host[:port]` origin, nothing else: no path, user or
    /// query. Plain http is refused.
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim().trim_end_matches('/');
        let Some(rest) = text.strip_prefix("https://") else {
            return Err(format!(
                "A kubectl download address must be https://, not {text:?}."
            ));
        };
        let authority: http::uri::Authority = rest
            .parse()
            .map_err(|_| format!("Not a valid download address: {text:?}."))?;
        if authority.as_str() != rest || rest.contains('@') || rest.is_empty() {
            return Err(format!(
                "A download address is only https:// and a host and port: {text:?}."
            ));
        }
        Ok(DownloadBase {
            origin: text.to_string(),
            host: authority.host().to_string(),
        })
    }

    /// The host requests may go to. Redirects to any other host are refused.
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn is_official(&self) -> bool {
        self.host == OFFICIAL_HOST
    }

    /// The URL of the kubectl binary of `version` for `platform`.
    pub fn binary_url(&self, version: &KubeVersion, platform: &Platform) -> String {
        format!(
            "{}/release/{}/bin/{}/{}/{}",
            self.origin,
            version.tag(),
            platform.os,
            platform.arch,
            platform.binary_name()
        )
    }

    /// The URL of the binary's published SHA-256.
    pub fn checksum_url(&self, version: &KubeVersion, platform: &Platform) -> String {
        format!("{}.sha256", self.binary_url(version, platform))
    }
}

/// The SHA-256 in a `.sha256` file: 64 hex digits, optionally followed by
/// whitespace and a file name. Lowercased.
pub fn parse_sha256(text: &str) -> Result<String, String> {
    let hex = text.split_whitespace().next().unwrap_or_default();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("dl.k8s.io did not send a valid SHA-256 for kubectl.".into());
    }
    Ok(hex.to_ascii_lowercase())
}

/// The SHA-256 of `bytes`, in lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `Ok` if `bytes` hash to `expected` (lowercase hex), else why not.
pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "The downloaded kubectl's SHA-256 ({actual}) does not match the one dl.k8s.io \
             publishes ({expected}). It was not saved."
        ))
    }
}

/// The folder of the downloaded kubectl `version` under the app's data dir:
/// `<data>/kubectl/v1.31.2`.
pub fn version_dir(data_dir: &Path, version: &KubeVersion) -> PathBuf {
    data_dir.join("kubectl").join(version.tag())
}

/// The name of the saved checksum next to a downloaded binary.
fn checksum_name(binary_name: &str) -> String {
    format!("{binary_name}.sha256")
}

/// The downloaded kubectl `version`, if it is there and still matches the
/// SHA-256 saved with it: a regular file, not a link. A binary that does
/// not match, or has no saved checksum, is deleted (so it is offered
/// again). Reads and hashes the whole binary: call it off the async
/// runtime's threads.
pub fn installed(data_dir: &Path, version: &KubeVersion, platform: &Platform) -> Option<PathBuf> {
    let dir = version_dir(data_dir, version);
    let path = dir.join(platform.binary_name());
    let sum_path = dir.join(checksum_name(platform.binary_name()));
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let saved = std::fs::symlink_metadata(&sum_path)
        .ok()
        .filter(|m| m.file_type().is_file())
        .and_then(|_| std::fs::read_to_string(&sum_path).ok())
        .and_then(|t| parse_sha256(&t).ok());
    let matches = match (&saved, std::fs::read(&path)) {
        (Some(expected), Ok(bytes)) => sha256_hex(&bytes) == *expected,
        _ => false,
    };
    if matches {
        return Some(path);
    }
    tracing::warn!(
        "the downloaded kubectl {} does not match its saved SHA-256; deleting it",
        path.display()
    );
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&sum_path);
    None
}

/// Something that GETs a URL over https and returns its body, refusing a
/// body over `max` bytes.
pub trait Fetch {
    fn get(&self, url: &str, max: u64) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
}

/// Download kubectl `version` for `platform` from `base`, check it against
/// its published SHA-256 and save it under `data_dir` (see
/// [`version_dir`]). Returns the binary's path. Nothing is saved unless
/// the checksum matches.
pub async fn download(
    fetch: &impl Fetch,
    base: &DownloadBase,
    version: &KubeVersion,
    platform: &Platform,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let sum = fetch
        .get(&base.checksum_url(version, platform), MAX_CHECKSUM_BYTES)
        .await?;
    let expected = parse_sha256(&String::from_utf8_lossy(&sum))?;
    let binary = fetch
        .get(&base.binary_url(version, platform), MAX_BINARY_BYTES)
        .await?;
    verify_sha256(&binary, &expected)?;
    let dir = version_dir(data_dir, version);
    let name = platform.binary_name();
    let saved = (|| {
        // The checksum first: a binary without it is never used.
        install(
            &dir,
            &checksum_name(name),
            format!("{expected}\n").as_bytes(),
            0o400,
        )?;
        install(&dir, name, &binary, 0o500)
    })();
    saved.map_err(|e| format!("Could not save kubectl {version} in {}: {e}", dir.display()))
}

/// Write `bytes` to `dir/name` atomically: a new private temp file in
/// `dir` (0600), synced, renamed over `name`, then set to `mode` (Unix;
/// 0500 for the binary: read and run by its owner only). The folders are
/// created private (0700 on Unix).
pub fn install(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> std::io::Result<PathBuf> {
    create_private_dir(dir)?;
    let target = dir.join(name);
    let temp = dir.join(format!(".{name}.{}.part", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let result = (|| {
        let mut file = new_private_file(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, &target)?;
        set_mode(&target, mode)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    Ok(target)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // The two folders this module owns: `kubectl` and the version's.
        for d in [dir.parent(), Some(dir)].into_iter().flatten() {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

fn new_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Owner only, until `install` sets the final mode.
        options.mode(0o600);
    }
    options.open(path)
}

/// `PATH` with `dir` first, for one terminal's environment.
pub fn path_with_first(dir: &Path, current: Option<&OsStr>) -> OsString {
    let mut dirs = vec![dir.to_path_buf()];
    if let Some(current) = current {
        dirs.extend(std::env::split_paths(current));
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| dir.as_os_str().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn v(text: &str) -> KubeVersion {
        KubeVersion::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    #[test]
    fn parses_server_versions_and_drops_vendor_suffixes() {
        assert_eq!(v("v1.31.2").tag(), "v1.31.2");
        assert_eq!(v("v1.31.2+k3s1").tag(), "v1.31.2");
        assert_eq!(v("v1.30.5-eks-ce1d5eb").tag(), "v1.30.5");
        assert_eq!(v(" v1.29.0 ").tag(), "v1.29.0");
        assert_eq!(v("v1.32.0-alpha.1").tag(), "v1.32.0");
    }

    #[test]
    fn refuses_versions_that_could_leave_the_url_or_path() {
        for bad in [
            "",
            "1.31.2",
            "v1.31",
            "v1.31.2.4",
            "v1..2",
            "v1.31.x",
            "v1.31.2/../../evil",
            "v1.31.2/bin",
            "v1.31.2%2f..",
            "v1.31.2\\..\\x",
            "v1.31.2?x=1",
            "v1.31.2#x",
            "../v1.31.2",
            "v1.031.2",
            "v1.31.2222",
            "v99999999999.1.1",
            "v2.0.0",
            "v0.1.0",
            "v1.31.2 extra",
        ] {
            assert!(KubeVersion::parse(bad).is_err(), "{bad:?} was accepted");
        }
        // The error does not echo an endless string.
        let long = format!("v{}", "9".repeat(10_000));
        assert!(KubeVersion::parse(&long).unwrap_err().len() < 200);
    }

    #[test]
    fn skew_is_more_than_one_minor_version() {
        let server = v("v1.31.0");
        assert!(!skew_too_large(Some(&v("v1.31.9")), &server));
        assert!(!skew_too_large(Some(&v("v1.30.0")), &server));
        assert!(!skew_too_large(Some(&v("v1.32.1")), &server));
        assert!(skew_too_large(Some(&v("v1.29.3")), &server));
        assert!(skew_too_large(Some(&v("v1.33.0")), &server));
        assert!(skew_too_large(None, &server));
    }

    #[test]
    fn reads_kubectls_own_version() {
        let json = r#"{"clientVersion":{"major":"1","minor":"30","gitVersion":"v1.30.4","platform":"linux/amd64"},
            "kustomizeVersion":"v5.0.4"}"#;
        assert_eq!(parse_client_version(json), Some(v("v1.30.4")));
        assert_eq!(parse_client_version("not json"), None);
        assert_eq!(parse_client_version(r#"{"clientVersion":{}}"#), None);
    }

    #[test]
    fn builds_dl_k8s_io_urls() {
        let base = DownloadBase::official();
        let linux = Platform::of("linux", "x86_64").unwrap();
        assert_eq!(
            base.binary_url(&v("v1.31.2"), &linux),
            "https://dl.k8s.io/release/v1.31.2/bin/linux/amd64/kubectl"
        );
        assert_eq!(
            base.checksum_url(&v("v1.31.2+k3s1"), &linux),
            "https://dl.k8s.io/release/v1.31.2/bin/linux/amd64/kubectl.sha256"
        );
        let mac = Platform::of("macos", "aarch64").unwrap();
        assert_eq!(
            base.binary_url(&v("v1.29.0"), &mac),
            "https://dl.k8s.io/release/v1.29.0/bin/darwin/arm64/kubectl"
        );
        let win = Platform::of("windows", "x86_64").unwrap();
        assert_eq!(
            base.binary_url(&v("v1.29.0"), &win),
            "https://dl.k8s.io/release/v1.29.0/bin/windows/amd64/kubectl.exe"
        );
        assert!(Platform::of("freebsd", "x86_64").is_err());
        assert!(Platform::of("linux", "riscv64").is_err());
        assert!(base.is_official());
    }

    #[test]
    fn a_download_address_is_https_and_only_an_origin() {
        let b = DownloadBase::parse("https://127.0.0.1:8443/").unwrap();
        assert_eq!(b.host(), "127.0.0.1");
        assert!(!b.is_official());
        assert_eq!(
            b.binary_url(&v("v1.31.2"), &Platform::of("linux", "aarch64").unwrap()),
            "https://127.0.0.1:8443/release/v1.31.2/bin/linux/arm64/kubectl"
        );
        for bad in [
            "http://dl.k8s.io",
            "dl.k8s.io",
            "ftp://dl.k8s.io",
            "https://",
            "https://dl.k8s.io/release",
            "https://me:pw@dl.k8s.io",
            "https://dl.k8s.io?x",
            "https://dl .k8s.io",
        ] {
            assert!(DownloadBase::parse(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn checks_the_published_sha256() {
        let body = b"kubectl";
        let sum = sha256_hex(body);
        assert_eq!(parse_sha256(&format!("{sum}\n")).unwrap(), sum);
        assert_eq!(
            parse_sha256(&format!("{}  kubectl\n", sum.to_uppercase())).unwrap(),
            sum
        );
        assert!(verify_sha256(body, &sum).is_ok());
        let e = verify_sha256(b"kubectl, tampered", &sum).unwrap_err();
        assert!(e.contains("does not match"), "{e}");
        for bad in [
            "",
            "abc",
            &"g".repeat(64),
            "<html>404</html>",
            &"a".repeat(65),
        ] {
            assert!(parse_sha256(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn puts_the_folder_first_on_path() {
        let path = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let joined = path_with_first(Path::new("/data/kubectl/v1.31.2"), Some(&path));
        let dirs: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(dirs[0], Path::new("/data/kubectl/v1.31.2"));
        assert_eq!(
            dirs[1..],
            [PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
        );
        assert_eq!(path_with_first(Path::new("/d"), None), OsString::from("/d"));
    }

    /// Serves fixed bodies by URL and records what was asked.
    struct FakeFetch {
        bodies: Vec<(String, Vec<u8>)>,
        asked: Mutex<Vec<String>>,
    }

    impl Fetch for FakeFetch {
        async fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
            self.asked.lock().unwrap().push(url.to_string());
            let body = self
                .bodies
                .iter()
                .find(|(u, _)| u == url)
                .map(|(_, b)| b.clone())
                .ok_or_else(|| format!("404 {url}"))?;
            if body.len() as u64 > max {
                return Err("too big".into());
            }
            Ok(body)
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nauvi-331-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn fake(binary: &[u8], published: &str) -> FakeFetch {
        let base = DownloadBase::official();
        let p = Platform::of("linux", "x86_64").unwrap();
        let ver = v("v1.31.2");
        FakeFetch {
            bodies: vec![
                (base.checksum_url(&ver, &p), published.as_bytes().to_vec()),
                (base.binary_url(&ver, &p), binary.to_vec()),
            ],
            asked: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn downloads_verifies_and_saves_privately() {
        let data = temp_dir("ok");
        let binary = b"#!/bin/sh\necho kubectl\n";
        let f = fake(binary, &format!("{}\n", sha256_hex(binary)));
        let p = Platform::of("linux", "x86_64").unwrap();
        let ver = v("v1.31.2+k3s1");
        assert_eq!(installed(&data, &ver, &p), None);
        let path = download(&f, &DownloadBase::official(), &ver, &p, &data)
            .await
            .unwrap();
        assert_eq!(path, data.join("kubectl/v1.31.2/kubectl"));
        assert_eq!(std::fs::read(&path).unwrap(), binary);
        assert_eq!(installed(&data, &ver, &p), Some(path.clone()));
        // The checksum first, then the binary, both from dl.k8s.io.
        let asked = f.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 2);
        assert!(asked[0].ends_with(".sha256"));
        assert!(asked
            .iter()
            .all(|u| u.starts_with("https://dl.k8s.io/release/v1.31.2/")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            // Read and run by its owner only, after the rename.
            assert_eq!(mode(&path), 0o500);
            assert_eq!(mode(&data.join("kubectl/v1.31.2/kubectl.sha256")), 0o400);
            assert_eq!(mode(&data.join("kubectl")), 0o700);
            assert_eq!(mode(&data.join("kubectl/v1.31.2")), 0o700);
        }
        // No temp file is left.
        let mut left: Vec<_> = std::fs::read_dir(data.join("kubectl/v1.31.2"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(left, ["kubectl", "kubectl.sha256"]);
        // A second download replaces the read-only files in place.
        download(&f, &DownloadBase::official(), &ver, &p, &data)
            .await
            .unwrap();
        assert_eq!(installed(&data, &ver, &p), Some(path));
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[tokio::test]
    async fn a_binary_changed_after_download_is_deleted_and_offered_again() {
        let data = temp_dir("changed");
        let binary = b"#!/bin/sh\necho kubectl\n";
        let f = fake(binary, &sha256_hex(binary));
        let p = Platform::of("linux", "x86_64").unwrap();
        let ver = v("v1.31.2");
        let path = download(&f, &DownloadBase::official(), &ver, &p, &data)
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(&path, b"#!/bin/sh\necho changed\n").unwrap();
        assert_eq!(installed(&data, &ver, &p), None);
        assert!(!path.exists(), "the changed binary was not deleted");
        assert!(!path.with_file_name("kubectl.sha256").exists());

        // Downloaded again, it is used again.
        download(&f, &DownloadBase::official(), &ver, &p, &data)
            .await
            .unwrap();
        assert_eq!(installed(&data, &ver, &p), Some(path.clone()));

        // Without its saved checksum it is not used either.
        let sum = path.with_file_name("kubectl.sha256");
        std::fs::remove_file(&sum).unwrap();
        assert_eq!(installed(&data, &ver, &p), None);
        assert!(!path.exists());
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[tokio::test]
    async fn a_checksum_mismatch_saves_nothing() {
        let data = temp_dir("mismatch");
        let f = fake(b"tampered kubectl", &sha256_hex(b"real kubectl"));
        let p = Platform::of("linux", "x86_64").unwrap();
        let e = download(&f, &DownloadBase::official(), &v("v1.31.2"), &p, &data)
            .await
            .unwrap_err();
        assert!(e.contains("does not match"), "{e}");
        assert!(!data.exists(), "something was written");

        // A checksum file that is not one (an error page) is refused too.
        let f = fake(b"kubectl", "<html>Not found</html>");
        let e = download(&f, &DownloadBase::official(), &v("v1.31.2"), &p, &data)
            .await
            .unwrap_err();
        assert!(e.contains("valid SHA-256"), "{e}");
        assert!(!data.exists());
    }

    #[tokio::test]
    async fn a_failed_fetch_saves_nothing() {
        let data = temp_dir("404");
        let f = fake(b"kubectl", &sha256_hex(b"kubectl"));
        let p = Platform::of("linux", "x86_64").unwrap();
        // Not served by the fake: another version.
        let e = download(&f, &DownloadBase::official(), &v("v1.30.0"), &p, &data)
            .await
            .unwrap_err();
        assert!(e.contains("404"), "{e}");
        assert!(!data.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_binary_is_not_used() {
        let data = temp_dir("link");
        let ver = v("v1.31.2");
        let p = Platform::of("linux", "x86_64").unwrap();
        let dir = version_dir(&data, &ver);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink("/bin/sh", dir.join("kubectl")).unwrap();
        assert_eq!(installed(&data, &ver, &p), None);
        std::fs::remove_dir_all(&data).unwrap();
    }
}
