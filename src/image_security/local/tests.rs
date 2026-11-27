use super::*;

fn d(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nauvi-536-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn a_reference_is_rebuilt_from_its_parts_by_digest() {
    let t = scan_target("nginx:1.27", &d('a'), "linux/amd64").unwrap();
    assert_eq!(t.reference, format!("docker.io/library/nginx@{}", d('a')));
    assert_eq!(t.registry, "docker.io");
    assert_eq!(t.platform, "linux/amd64");
    // The digest that runs wins over one pinned in the reference.
    let pinned = scan_target(&format!("ghcr.io/org/app:1@{}", d('b')), &d('c'), "").unwrap();
    assert_eq!(pinned.reference, format!("ghcr.io/org/app@{}", d('c')));
    let port = scan_target(
        "registry.example.com:5000/team/app",
        &d('a'),
        "linux/arm64/v8",
    )
    .unwrap();
    assert_eq!(
        port.reference,
        format!("registry.example.com:5000/team/app@{}", d('a'))
    );
}

#[test]
fn hostile_references_are_refused() {
    for bad in [
        "--help",
        "-o/etc/passwd",
        "--output=/tmp/x",
        "--server=http://evil",
        "nginx;rm -rf ~",
        "nginx$(id)",
        "nginx`id`",
        "nginx|sh",
        "nginx&&id",
        "nginx>x",
        "nginx\nid",
        "nginx:1.27\n--help",
        "nginx\r",
        "nginx\0",
        "nginx 1",
        "ngi nx",
        "\u{202e}nginx",
        "a/../b",
        "evil.com/a%2f",
        "Mongo",
        "",
        "localhost:5000/app",
        "127.0.0.1:5000/app",
        "169.254.169.254/app",
        "metadata.google.internal/app",
        "[::1]:5000/app",
    ] {
        assert!(
            scan_target(bad, &d('a'), "").is_err(),
            "{bad:?} was accepted"
        );
    }
    let long = format!("{}:1", "a".repeat(600));
    assert!(scan_target(&long, &d('a'), "").is_err());
}

#[test]
fn only_a_real_digest_and_platform() {
    assert!(scan_target("nginx", "", "")
        .unwrap_err()
        .contains("by digest only"));
    for bad in [
        "sha256:abc",
        "sha512:aa",
        "--help",
        &format!("sha256:{}", "A".repeat(64)),
        &format!("sha256:{};id", "a".repeat(64)),
    ] {
        assert!(scan_target("nginx", bad, "").is_err(), "{bad:?}");
    }
    for bad in [
        "linux",
        "linux/amd64/v8/x",
        "linux/AMD64",
        "--x/y",
        "linux/amd 64",
        "linux/$(id)",
    ] {
        assert!(scan_target("nginx", &d('a'), bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_reference_is_the_last_item_after_a_double_dash() {
    let t = scan_target("nginx:1.27", &d('a'), "linux/amd64").unwrap();
    let o = ScanOptions {
        db_repository: "mirror.gcr.io/aquasec/trivy-db:2".into(),
        skip_db_update: true,
        server_url: String::new(),
    };
    let args = scan_args(ScannerKind::Trivy, "0.58.1", &t, &o);
    assert_eq!(
        args,
        [
            "image",
            "--format=json",
            "--quiet",
            "--scanners=vuln",
            "--image-src=remote",
            "--skip-version-check",
            "--platform=linux/amd64",
            "--db-repository=mirror.gcr.io/aquasec/trivy-db:2",
            "--skip-db-update",
            "--skip-java-db-update",
            "--",
            &t.reference,
        ]
    );
    // Old Trivy has no --skip-version-check; a server takes the DB options' place.
    let server = ScanOptions {
        server_url: "https://trivy.internal:4954".into(),
        ..o.clone()
    };
    let args = scan_args(ScannerKind::Trivy, "0.50.0", &t, &server);
    assert!(!args.iter().any(|a| a == "--skip-version-check"));
    assert!(args.contains(&"--server=https://trivy.internal:4954".to_string()));
    assert!(!args.iter().any(|a| a.starts_with("--db-repository")));
    let grype = scan_args(ScannerKind::Grype, "0.84.0", &t, &ScanOptions::default());
    assert_eq!(
        grype,
        [
            "--output=json",
            "--quiet",
            "--platform=linux/amd64",
            "--",
            &format!("registry:{}", t.reference),
        ]
    );
    for args in [args, grype] {
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(dash, args.len() - 2);
    }
}

#[test]
fn trivy_runs_without_telemetry_or_a_version_check() {
    for o in [
        ScanOptions::default(),
        ScanOptions {
            skip_db_update: true,
            ..Default::default()
        },
    ] {
        let env = env_of(ScannerKind::Trivy, &o);
        assert!(env.contains(&("TRIVY_DISABLE_TELEMETRY".into(), "true".into())));
        assert!(env.contains(&("TRIVY_SKIP_VERSION_CHECK".into(), "true".into())));
    }
    let grype = env_of(ScannerKind::Grype, &ScanOptions::default());
    assert!(grype.contains(&("GRYPE_CHECK_FOR_APP_UPDATE".into(), "false".into())));
    assert!(!grype.iter().any(|(k, _)| k.starts_with("TRIVY_")));
}

#[test]
fn options_are_checked() {
    let ok = ScanOptions {
        db_repository: "ghcr.io/aquasecurity/trivy-db:2".into(),
        server_url: "http://10.0.0.5:4954".into(),
        skip_db_update: false,
    };
    assert_eq!(check_options(ScannerKind::Trivy, &ok), Ok(()));
    assert!(check_options(ScannerKind::Grype, &ok).is_err());
    for db in ["--x", "a b", "localhost/db", "169.254.169.254/db", "x;y"] {
        let o = ScanOptions {
            db_repository: db.into(),
            ..Default::default()
        };
        assert!(check_options(ScannerKind::Trivy, &o).is_err(), "{db:?}");
    }
    for url in [
        "ftp://x",
        "file:///etc",
        "--server",
        "http://user:pw@x",
        "http://x y",
        "x",
    ] {
        let o = ScanOptions {
            server_url: url.into(),
            ..Default::default()
        };
        assert!(check_options(ScannerKind::Trivy, &o).is_err(), "{url:?}");
    }
}

#[test]
fn malicious_trivy_releases_are_refused() {
    for v in ["0.69.4", "v0.69.5", "0.69.6", "0.69.4-rc1"] {
        let why = refused_version(ScannerKind::Trivy, v).unwrap();
        assert!(why.contains("CVE-2026-33634"), "{v}: {why}");
    }
    for v in ["0.69.3", "0.69.7", "0.58.1", "v0.70.0"] {
        assert_eq!(refused_version(ScannerKind::Trivy, v), None, "{v}");
    }
    // Grype has no such release; an unreadable version is refused.
    assert_eq!(refused_version(ScannerKind::Grype, "0.69.5"), None);
    assert!(refused_version(ScannerKind::Trivy, "dev").is_some());
    assert!(refused_version(ScannerKind::Trivy, "").is_some());
    assert_eq!(parse_version("v1.2"), Some((1, 2, 0)));
}

/// The build info alone refuses the malicious releases, by the module's
/// version or by the version the release build set; anything else is left
/// to the version the binary prints.
#[test]
fn malicious_trivy_builds_are_refused_from_the_file() {
    use crate::image_security::go_buildinfo::{fixture, BuildInfo};
    let info = |module: &str, version: &str, x: &[(&str, &str)]| BuildInfo {
        main_module: module.into(),
        main_version: version.into(),
        ldflags_x: x
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect(),
        ..BuildInfo::default()
    };
    let t = ScannerKind::Trivy;
    for v in [
        "v0.69.4",
        "v0.69.5",
        "v0.69.6",
        "v0.69.4-0.20260301000000-abcdef012345",
    ] {
        let why = refused_plain(t, Some(&info(TRIVY_MODULE, v, &[]))).unwrap();
        assert!(
            why.contains("is one of the malicious releases"),
            "{v}: {why}"
        );
    }
    // A devel build with the release's version set.
    let x = [(TRIVY_VERSION_VAR, "0.69.6")];
    let why = refused_plain(t, Some(&info(TRIVY_MODULE, "(devel)", &x))).unwrap();
    assert!(why.contains("Trivy 0.69.6 is one"), "{why}");
    // A fine module version, but the version set is a malicious one.
    let why = refused_plain(t, Some(&info(TRIVY_MODULE, "v0.58.1", &x))).unwrap();
    assert!(why.contains("Trivy 0.69.6 is one"), "{why}");
    // Fine.
    assert!(refused_plain(t, Some(&info(TRIVY_MODULE, "v0.69.3", &[]))).is_none());
    let x = [(TRIVY_VERSION_VAR, "0.58.1")];
    assert!(refused_plain(t, Some(&info(TRIVY_MODULE, "(devel)", &x))).is_none());
    // Trivy 0.26 and before: `-X main.version=`, no module.
    let old = [("main.version", "0.26.0")];
    assert!(refused_plain(t, Some(&info("", "", &old))).is_none());
    // Another module's version is not Trivy's.
    let why = refused_plain(t, Some(&info("example.com/other", "v0.69.5", &[]))).unwrap();
    assert!(why.contains("names no version"), "{why}");
    // Grype has no malicious release to look for.
    assert!(refused_plain(
        ScannerKind::Grype,
        Some(&info(TRIVY_MODULE, "v0.69.5", &[]))
    )
    .is_none());

    // From a file, in the same read as its hash.
    let dir = temp("buildinfo");
    let file = dir.join("trivy");
    let mut data = vec![0u8; 1024 * 1024 + 48];
    data.extend_from_slice(&fixture::block("go1.24.1", fixture::TRIVY));
    data.extend_from_slice(&[0u8; 4096]);
    std::fs::write(&file, &data).unwrap();
    let (fp, build) = inspect(&file).unwrap();
    assert_eq!(fp, fingerprint(&file).unwrap());
    assert!(refused_plain(t, build.as_ref()).is_some());
    let _ = std::fs::remove_dir_all(dir);
}

/// A Trivy whose file names no version is refused before it runs (#561):
/// nauvi cannot tell it from a malicious release. Grype is not.
#[test]
fn a_trivy_whose_file_names_no_version_is_refused() {
    use crate::image_security::go_buildinfo::{find, fixture};
    let t = ScannerKind::Trivy;
    // A `(devel)` build under -trimpath: Go records no -ldflags then.
    let devel = find(&fixture::block(
        "go1.23.4",
        "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
         mod\tgithub.com/aquasecurity/trivy\t(devel)\t\n\
         dep\tgithub.com/spf13/cobra\tv1.8.0\th1:def=\n\
         build\t-trimpath=true\n",
    ));
    let why = refused_plain(t, devel.as_ref()).unwrap();
    assert!(
        why.starts_with("This Trivy's Go build info names no version"),
        "{why}"
    );
    assert!(why.contains("CVE-2026-33634"), "{why}");
    assert!(
        why.contains(&format!("-X {TRIVY_VERSION_VAR}=<version>")),
        "{why}"
    );
    // A -X that is not a version.
    let odd = find(&fixture::block(
        "go1.23.4",
        &format!(
            "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
             mod\tgithub.com/aquasecurity/trivy\t(devel)\t\n\
             build\t-ldflags=\"-X {TRIVY_VERSION_VAR}=dev\"\n"
        ),
    ));
    assert!(refused_plain(t, odd.as_ref())
        .unwrap()
        .contains("names no version"));
    // A packed (UPX) binary, or a script: no build info nauvi can read.
    let mut packed = b"\x7fELF\x02\x01\x01UPX!".to_vec();
    packed.resize(64 * 1024, 0x5a);
    assert!(find(&packed).is_none());
    let why = refused_plain(t, None).unwrap();
    assert!(
        why.starts_with("nauvi finds no Go build info in this file"),
        "{why}"
    );
    assert!(why.contains("Install a release build of Trivy"), "{why}");
    assert!(why.ends_with("or set NAUVI_TRIVY to one."), "{why}");
    // A release build (as 0.76.2's reads) runs.
    let release = find(&fixture::block(
        "go1.27.3",
        &format!(
            "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
             mod\tgithub.com/aquasecurity/trivy\tv0.76.2\t\n\
             build\t-ldflags=\"-s -w -extldflags '-static' -X {TRIVY_VERSION_VAR}=0.76.2\"\n"
        ),
    ));
    assert!(refused_plain(t, release.as_ref()).is_none());
    // Grype: the version it prints is what is checked.
    assert!(refused_plain(ScannerKind::Grype, None).is_none());
    assert!(refused_plain(ScannerKind::Grype, devel.as_ref()).is_none());
}

/// [`refused_build`] of a file outside any package manager's folder.
fn refused_plain(
    kind: ScannerKind,
    info: Option<&crate::image_security::go_buildinfo::BuildInfo>,
) -> Option<String> {
    refused_build(kind, info, Path::new("/usr/local/bin/trivy"))
}

/// Homebrew builds Trivy with -trimpath from a source tarball: a `(devel)`
/// build info without -ldflags. Its version comes from its Cellar folder
/// (or a Nix store path), checked the same way, and is shown (#561).
#[test]
fn a_versionless_trivy_in_a_package_folder_takes_the_folder_s_version() {
    use crate::image_security::go_buildinfo::{find, fixture};
    let t = ScannerKind::Trivy;
    let brew = find(&fixture::block(
        "go1.25.3",
        "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
         mod\tgithub.com/aquasecurity/trivy\t(devel)\t\n\
         build\t-trimpath=true\n",
    ));
    let cellar = Path::new("/opt/homebrew/Cellar/trivy/0.58.1/bin/trivy");
    assert_eq!(refused_build(t, brew.as_ref(), cellar), None);
    assert_eq!(
        file_version_note(t, brew.as_ref(), cellar).as_deref(),
        Some("Version 0.58.1 from its Homebrew folder.")
    );
    let nix = Path::new("/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-0.58.1/bin/trivy");
    assert_eq!(refused_build(t, brew.as_ref(), nix), None);
    assert_eq!(
        file_version_note(t, brew.as_ref(), nix).as_deref(),
        Some("Version 0.58.1 from its Nix store path.")
    );
    // A malicious version from the folder, with a revision or not.
    for p in [
        "/opt/homebrew/Cellar/trivy/0.69.5_1/bin/trivy",
        "/usr/local/Cellar/trivy/0.69.4/bin/trivy",
        "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-0.69.6/bin/trivy",
    ] {
        let why = refused_build(t, brew.as_ref(), Path::new(p)).unwrap();
        assert!(
            why.contains("is one of the malicious releases"),
            "{p}: {why}"
        );
        assert!(
            why.contains("nauvi read its version from its"),
            "{p}: {why}"
        );
    }
    // Lookalikes: refused as naming no version.
    for p in [
        "/opt/homebrew/Cellar/trivy-evil/0.58.1/bin/trivy",
        "/opt/homebrew/Cellar/trivy/0.58.1/libexec/bin/trivy",
        "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4h-trivy-0.58.1/bin/trivy",
        "/home/me/go/bin/trivy",
    ] {
        let why = refused_build(t, brew.as_ref(), Path::new(p)).unwrap();
        assert!(why.contains("names no version"), "{p}: {why}");
        assert_eq!(file_version_note(t, brew.as_ref(), Path::new(p)), None);
    }
    // The build info's version wins over the folder's.
    let release = find(&fixture::block("go1.24.1", fixture::TRIVY));
    let why = refused_build(t, release.as_ref(), cellar).unwrap();
    assert!(why.contains("Trivy 0.69.5 is one"), "{why}");
    assert_eq!(file_version_note(t, release.as_ref(), cellar), None);
    // No build info (a script, a packed file) in a Cellar: still refused.
    let why = refused_build(t, None, cellar).unwrap();
    assert!(why.starts_with("nauvi finds no Go build info"), "{why}");
    // Grype: never a note.
    assert_eq!(
        file_version_note(ScannerKind::Grype, brew.as_ref(), cellar),
        None
    );
}

#[cfg(unix)]
#[test]
fn the_binary_comes_from_the_variable_or_an_absolute_path_entry() {
    let dir = temp("find");
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let trivy = script(&bin, "trivy", "exit 0");
    let path = std::env::join_paths([PathBuf::from("relative"), bin.clone()]).unwrap();
    let found = find_in(ScannerKind::Trivy, None, Some(path.clone())).unwrap();
    assert_eq!(found, trivy.canonicalize().unwrap());
    // Not on PATH: a plain message, and nothing is fetched.
    let err = find_in(ScannerKind::Grype, None, Some(path)).unwrap_err();
    assert!(
        err.contains("grype is not installed or not on PATH"),
        "{err}"
    );
    assert!(err.contains("never downloads"));
    assert!(err.contains("NAUVI_GRYPE"));
    // A relative PATH entry is never searched.
    let cwd_only = std::env::join_paths([PathBuf::from(".")]).unwrap();
    assert!(find_in(ScannerKind::Trivy, None, Some(cwd_only)).is_err());
    // The variable wins, and must be absolute and executable.
    let other = script(&dir, "my-trivy", "exit 0");
    assert_eq!(
        find_in(ScannerKind::Trivy, Some(other.clone().into()), None).unwrap(),
        other.canonicalize().unwrap()
    );
    assert!(find_in(ScannerKind::Trivy, Some("trivy".into()), None).is_err());
    let plain = dir.join("plain");
    std::fs::write(&plain, "x").unwrap();
    assert!(find_in(ScannerKind::Trivy, Some(plain.into()), None)
        .unwrap_err()
        .contains("not an executable file"));
    let _ = std::fs::remove_dir_all(dir);
}

/// nauvi never downloads a scanner or a database: without one there is
/// only the message, no network client in this module, and nothing is
/// written.
#[test]
fn nauvi_never_downloads_a_scanner() {
    let dir = temp("nodownload");
    let empty = std::env::join_paths([dir.clone()]).unwrap();
    for kind in [ScannerKind::Trivy, ScannerKind::Grype] {
        let err = find_in(kind, None, Some(empty.clone())).unwrap_err();
        assert_eq!(err, not_installed(kind));
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    let sources = [
        include_str!("../local.rs"),
        include_str!("../cache.rs"),
        include_str!("../trivy_json.rs"),
        include_str!("../grype_json.rs"),
    ];
    for src in sources {
        for word in [
            "reqwest",
            "hyper::",
            "TcpStream",
            "kubectl_download",
            "registry_tags::http",
        ] {
            assert!(!src.contains(word), "{word} in the local scanner");
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn fingerprints_change_with_the_file() {
    let dir = temp("fp");
    let p = dir.join("bin");
    std::fs::write(&p, "one").unwrap();
    let a = fingerprint(&p).unwrap();
    assert_eq!(a.size, 3);
    assert_eq!(a.sha256.len(), 64);
    std::fs::write(&p, "two").unwrap();
    let b = fingerprint(&p).unwrap();
    assert_ne!(a.sha256, b.sha256);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn failures_in_plain_words() {
    let t = scan_target("ghcr.io/org/app", &d('a'), "").unwrap();
    let failed = |stderr: &str| RunError::Failed {
        status: "exit status: 1".into(),
        stderr: stderr.into(),
    };
    let net = failure_text(
        ScannerKind::Trivy,
        &failed("2026-11-26T10:00:00Z\tFATAL\tFatal error\timage scan error: unable to inspect: Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host\n"),
        &t,
    );
    assert!(
        net.starts_with("This computer cannot reach the registry ghcr.io."),
        "{net}"
    );
    assert!(net.contains("no such host"));
    assert!(!net.contains("FATAL"), "{net}");
    let auth = failure_text(
        ScannerKind::Grype,
        &failed("GET https://ghcr.io/...: UNAUTHORIZED: authentication required"),
        &t,
    );
    assert!(auth.contains("did not let Grype pull"), "{auth}");
    assert!(auth.contains("docker login ghcr.io"));
    let gone = failure_text(
        ScannerKind::Trivy,
        &failed("ERROR MANIFEST_UNKNOWN: manifest unknown"),
        &t,
    );
    assert!(gone.contains("has no image"), "{gone}");
    let db = failure_text(
        ScannerKind::Trivy,
        &failed("FATAL --skip-db-update cannot be specified on the first run"),
        &t,
    );
    assert!(db.contains("no vulnerability database yet"), "{db}");
    let other = failure_text(ScannerKind::Trivy, &failed("FATAL something odd"), &t);
    assert_eq!(
        other,
        format!("Trivy could not scan {}: something odd", t.reference)
    );
    let slow = failure_text(
        ScannerKind::Trivy,
        &RunError::TimedOut(Duration::from_secs(5)),
        &t,
    );
    assert!(slow.contains("did not finish within 5 s"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_scan_runs_the_binary_without_a_shell_in_its_own_folder() {
    let dir = temp("run");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let argv = dir.join("argv");
    // Prints each argument on its own line, and the folder it runs in.
    let fake = script(
        &dir,
        "trivy",
        &format!(
            "for a in \"$@\"; do printf '%s\\n' \"$a\" >> {argv}; done\npwd > {argv}.cwd\necho \"$TRIVY_DISABLE_TELEMETRY $TRIVY_SKIP_VERSION_CHECK\" > {argv}.env\ncat {json}",
            argv = argv.display(),
            json = concat!(env!("CARGO_MANIFEST_DIR"), "/src/image_security/testdata/trivy-scan.json"),
        ),
    );
    let t = scan_target("nginx:1.27", &d('a'), "linux/amd64").unwrap();
    let v = scan(
        ScannerKind::Trivy,
        &fake,
        "0.58.1",
        &t,
        &ScanOptions::default(),
        &work,
    )
    .await
    .unwrap();
    assert_eq!(v.len(), 3);
    let got = std::fs::read_to_string(&argv).unwrap();
    let lines: Vec<&str> = got.lines().collect();
    assert_eq!(lines[lines.len() - 2..], ["--", t.reference.as_str()]);
    let cwd = std::fs::read_to_string(format!("{}.cwd", argv.display())).unwrap();
    assert_eq!(
        Path::new(cwd.trim()).canonicalize().unwrap(),
        work.canonicalize().unwrap()
    );
    let env = std::fs::read_to_string(format!("{}.env", argv.display())).unwrap();
    assert_eq!(
        env.trim(),
        "true true",
        "telemetry and the version check off"
    );
    // A refused version never runs.
    std::fs::remove_file(&argv).unwrap();
    let err = scan(
        ScannerKind::Trivy,
        &fake,
        "0.69.5",
        &t,
        &ScanOptions::default(),
        &work,
    )
    .await
    .unwrap_err();
    assert!(format!("{err}").contains("malicious"));
    assert!(!argv.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[tokio::test]
async fn output_is_capped_and_a_dropped_scan_is_killed() {
    let dir = temp("cap");
    let big = script(&dir, "big", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let err = run_capped(&big, &[], &dir, &[], 1024 * 1024, Duration::from_secs(20))
        .await
        .unwrap_err();
    assert!(matches!(err, RunError::TooLarge(_)), "{err:?}");
    let slow = script(&dir, "slow", "sleep 30");
    let err = run_capped(&slow, &[], &dir, &[], 1024, Duration::from_millis(300))
        .await
        .unwrap_err();
    assert!(matches!(err, RunError::TimedOut(_)));
    // Cancelled: the future is dropped, and the child with it.
    let pidfile = dir.join("pid");
    let child = script(
        &dir,
        "child",
        &format!("echo $$ > {}\nexec sleep 30", pidfile.display()),
    );
    let run = run_capped(&child, &[], &dir, &[], 1024, Duration::from_secs(60));
    let _ = tokio::time::timeout(Duration::from_millis(500), run).await;
    let pid = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .to_string();
    let mut gone = false;
    for _ in 0..50 {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        // Gone, or a zombie waiting for the runtime to reap it.
        if stat.is_empty() || stat.contains(") Z") {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if cfg!(target_os = "linux") {
        assert!(gone, "the scanner still runs after the scan was dropped");
    }
    // Exited, but something it started still holds stderr: the group is
    // killed after a short wait instead of running until the timeout.
    let pidfile2 = dir.join("pid2");
    let holder = script(
        &dir,
        "holder",
        &format!(
            "sleep 60 >&2 &\necho $! > {}\necho done",
            pidfile2.display()
        ),
    );
    let started = std::time::Instant::now();
    let out = run_capped(&holder, &[], &dir, &[], 1024, Duration::from_secs(60))
        .await
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "done");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    let pid2 = std::fs::read_to_string(&pidfile2)
        .unwrap()
        .trim()
        .to_string();
    let mut gone2 = false;
    for _ in 0..50 {
        let stat = std::fs::read_to_string(format!("/proc/{pid2}/stat")).unwrap_or_default();
        if stat.is_empty() || stat.contains(") Z") {
            gone2 = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if cfg!(target_os = "linux") {
        assert!(gone2, "a process the scanner started outlived it");
    }
    let missing = run_capped(&dir.join("nope"), &[], &dir, &[], 1, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(matches!(missing, RunError::NotFound));
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[tokio::test]
async fn versions_are_read_from_the_scanner() {
    let dir = temp("version");
    let trivy = script(
        &dir,
        "trivy",
        r#"[ "$TRIVY_DISABLE_TELEMETRY" = true ] && [ "$TRIVY_SKIP_VERSION_CHECK" = true ] || exit 9
echo '{"Version":"0.58.1","VulnerabilityDB":{"UpdatedAt":"2026-11-25T06:00:00Z"}}'"#,
    );
    let v = scanner_version(ScannerKind::Trivy, &trivy, &dir)
        .await
        .unwrap();
    assert_eq!(v.version, "0.58.1");
    assert_eq!(v.db, "2026-11-25T06:00:00Z");
    let grype = script(
        &dir,
        "grype",
        r#"if [ "$1" = db ]; then echo '{"built":"2026-11-24T00:00:00Z"}'; else echo '{"version":"0.84.0"}'; fi"#,
    );
    let v = scanner_version(ScannerKind::Grype, &grype, &dir)
        .await
        .unwrap();
    assert_eq!(
        (v.version.as_str(), v.db.as_str()),
        ("0.84.0", "2026-11-24T00:00:00Z")
    );
    let broken = script(&dir, "broken", "echo nope >&2; exit 3");
    let err = scanner_version(ScannerKind::Trivy, &broken, &dir)
        .await
        .unwrap_err();
    assert!(
        format!("{err}").contains("trivy version failed: nope"),
        "{err}"
    );
    let _ = std::fs::remove_dir_all(dir);
}
