use super::*;

fn dirs(name: &str) -> ScanDirs {
    let root = std::env::temp_dir().join(format!("nauvi-536-scan-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    ScanDirs {
        config: root.join("config"),
        cache: root.join("cache").join("image-scans"),
    }
}

#[cfg(unix)]
fn script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The whole approval flow on a fake trivy (the tests that set
/// `NAUVI_TRIVY` hold [`TRIVY_VAR`]; nothing else in the app reads it).
#[cfg(unix)]
#[tokio::test]
async fn approve_once_ask_again_when_it_changes_refuse_bad_versions() {
    let _g = TRIVY_VAR.lock().await;
    let d = dirs("flow");
    let bin = d.config.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let trivy = bin.join("trivy");
    let ran = bin.join("ran");
    let version = |v: &str| {
        format!(
            "echo run >> {}\necho '{{\"Version\":\"{v}\",\"VulnerabilityDB\":{{\"UpdatedAt\":\"2026-11-25\"}}}}'",
            ran.display()
        )
    };
    script(&trivy, &version("0.58.1"));
    std::env::set_var("NAUVI_TRIVY", &trivy);
    let real = trivy.canonicalize().unwrap().display().to_string();

    // Found, not approved: nothing of it runs.
    let (s, path) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::Unapproved, "{s:?}");
    assert_eq!(s.path, real);
    assert!(s.file.contains("SHA-256 "), "{}", s.file);
    assert_eq!(s.from, "NAUVI_TRIVY");
    assert!(path.is_none());
    assert!(!ran.exists(), "the binary ran before it was approved");

    assert_eq!(s.sha256.len(), 64, "{s:?}");
    assert!(s.file.contains(&s.sha256[..12]));

    // Only the file found now, as it was shown, can be approved.
    let err = approve(&d, ScannerKind::Trivy, "/usr/bin/evil", &s.sha256)
        .await
        .unwrap_err();
    assert!(err.contains("is not the trivy nauvi finds now"), "{err}");
    let err = approve(&d, ScannerKind::Trivy, &real, &"0".repeat(64))
        .await
        .unwrap_err();
    assert_eq!(err, CHANGED_SINCE_SHOWN);
    let err = approve(&d, ScannerKind::Trivy, &real, "")
        .await
        .unwrap_err();
    assert_eq!(err, CHANGED_SINCE_SHOWN);
    assert_eq!(approval::approved(&d.approvals(), ScannerKind::Trivy), None);
    assert!(!ran.exists());
    let s = approve(&d, ScannerKind::Trivy, &real, &s.sha256)
        .await
        .unwrap();
    assert_eq!(s.state, ScannerState::Ready, "{s:?}");
    assert_eq!(
        (s.version.as_str(), s.db.as_str()),
        ("0.58.1", "2026-11-25")
    );
    assert!(ran.exists());

    // Changed (an update): asked again, and it does not run meanwhile.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    script(&trivy, &format!("{}\n# changed", version("0.58.2")));
    std::fs::remove_file(&ran).unwrap();
    let (s, path) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::Changed, "{s:?}");
    assert!(
        s.message.contains("changed since you approved it"),
        "{}",
        s.message
    );
    assert!(path.is_none());
    assert!(!ran.exists());

    // A malicious release (as it says once run): refused, and the
    // approval is dropped.
    script(&trivy, &version("0.69.4"));
    let shown = scanner_status(&d, ScannerKind::Trivy, false).await.0;
    let s = approve(&d, ScannerKind::Trivy, &real, &shown.sha256)
        .await
        .unwrap();
    assert_eq!(s.state, ScannerState::Refused, "{s:?}");
    assert!(s.message.contains("CVE-2026-33634"));
    assert_eq!(approval::approved(&d.approvals(), ScannerKind::Trivy), None);
    let (s, _) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::Unapproved);

    // Another path than the approved one.
    script(&trivy, &version("0.58.1"));
    let shown = scanner_status(&d, ScannerKind::Trivy, false).await.0;
    approve(&d, ScannerKind::Trivy, &real, &shown.sha256)
        .await
        .unwrap();
    let other = bin.join("trivy2");
    script(&other, &version("0.58.1"));
    std::env::set_var("NAUVI_TRIVY", &other);
    let (s, _) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::Changed);
    assert_eq!(s.approved_path, real);
    assert!(s.message.starts_with("You approved"), "{}", s.message);

    // Gone: a plain message.
    std::env::set_var("NAUVI_TRIVY", bin.join("missing"));
    let (s, _) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::NotInstalled);
    std::env::remove_var("NAUVI_TRIVY");
    let _ = std::fs::remove_dir_all(d.config.parent().unwrap());
}

/// The Go build info block of a Trivy 0.69.5 release build, as Go 1.18+
/// writes it (`nauvi::image_security::go_buildinfo` has the format).
fn malicious_block() -> Vec<u8> {
    let go = b"go1.24.1";
    let modinfo = "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
        mod\tgithub.com/aquasecurity/trivy\tv0.69.5\th1:x=\n";
    let mut b = b"\xff Go buildinf:".to_vec();
    b.extend_from_slice(&[8, 2]);
    b.resize(32, 0);
    b.push(go.len() as u8);
    b.extend_from_slice(go);
    let mut m = vec![0u8; 16];
    m.extend_from_slice(modinfo.as_bytes());
    m.extend_from_slice(&[0u8; 16]);
    b.push(m.len() as u8);
    b.extend_from_slice(&m);
    b
}

/// A file whose build info names a malicious Trivy is refused before
/// anything of it runs: not approved, not even asked its version, and an
/// approval kept from before is dropped.
#[cfg(unix)]
#[tokio::test]
async fn a_malicious_build_is_refused_without_running_it() {
    use std::os::unix::fs::PermissionsExt;
    let d = dirs("buildinfo");
    let bin = d.config.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let trivy = bin.join("trivy");
    let ran = bin.join("ran");
    let mut data = format!(
        "#!/bin/sh\necho run >> {}\necho '{{\"Version\":\"0.58.1\"}}'\nexit 0\n",
        ran.display()
    )
    .into_bytes();
    data.resize(data.len().div_ceil(16) * 16 + 64, b'#');
    data.extend_from_slice(&malicious_block());
    std::fs::write(&trivy, &data).unwrap();
    std::fs::set_permissions(&trivy, std::fs::Permissions::from_mode(0o755)).unwrap();
    let real = trivy.canonicalize().unwrap();
    let fp = fingerprint_of(&real).await.unwrap();
    // As if it had been approved before nauvi knew.
    approval::approve(&d.approvals(), ScannerKind::Trivy, fp.clone()).unwrap();

    let s = with_trivy(&real, || scanner_status(&d, ScannerKind::Trivy, true)).await;
    assert_eq!(s.0.state, ScannerState::Refused, "{:?}", s.0);
    assert!(s.0.message.contains("0.69.5"), "{}", s.0.message);
    assert!(s.1.is_none());
    assert_eq!(approval::approved(&d.approvals(), ScannerKind::Trivy), None);

    let real_s = real.display().to_string();
    let s = with_trivy(&real, || {
        approve(&d, ScannerKind::Trivy, &real_s, &fp.sha256)
    })
    .await
    .unwrap();
    assert_eq!(s.state, ScannerState::Refused, "{s:?}");
    assert_eq!(approval::approved(&d.approvals(), ScannerKind::Trivy), None);
    assert!(!ran.exists(), "nauvi ran a malicious build");
    let _ = std::fs::remove_dir_all(d.config.parent().unwrap());
}

/// Run `f` with `NAUVI_TRIVY` set to `path` (one test at a time sets it).
async fn with_trivy<F, T>(path: &Path, f: impl FnOnce() -> F) -> T
where
    F: std::future::Future<Output = T>,
{
    let _g = TRIVY_VAR.lock().await;
    std::env::set_var("NAUVI_TRIVY", path);
    let out = f().await;
    std::env::remove_var("NAUVI_TRIVY");
    out
}

/// Held while a test sets `NAUVI_TRIVY`.
static TRIVY_VAR: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A same-size rewrite with the modification time set back is hashed
/// again (the change time moved), and so is a swap (another inode).
#[cfg(unix)]
#[tokio::test]
async fn a_same_size_swap_with_an_old_mtime_is_hashed_again() {
    let d = dirs("swap");
    let p = d.config.parent().unwrap().join("bin-trivy");
    std::fs::write(&p, "aaaa").unwrap();
    let old = std::fs::metadata(&p).unwrap().modified().unwrap();
    let a = fingerprint_of(&p).await.unwrap();
    assert_eq!(
        file_text(&a),
        format!("4 bytes, SHA-256 {}…", &a.sha256[..12])
    );
    // Let the change time move on.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&p, "bbbb").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let b = fingerprint_of(&p).await.unwrap();
    assert_eq!((a.size, a.modified), (b.size, b.modified));
    assert_ne!(a.sha256, b.sha256, "the memo was used for another file");
    // A swap by rename: another inode.
    let other = p.with_extension("new");
    std::fs::write(&other, "cccc").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&other)
        .unwrap()
        .set_modified(old)
        .unwrap();
    std::fs::rename(&other, &p).unwrap();
    let c = fingerprint_of(&p).await.unwrap();
    assert_ne!(c.sha256, b.sha256);
    let _ = std::fs::remove_dir_all(d.config.parent().unwrap());
}

#[test]
fn file_text_is_short() {
    let fp = Fingerprint {
        path: "/x".into(),
        size: 50_000_000,
        modified: 0,
        sha256: "0123456789abcdef".into(),
    };
    assert_eq!(file_text(&fp), "47.7 MB, SHA-256 0123456789ab…");
}

#[tokio::test]
async fn one_scan_at_a_time() {
    let (slot, cancel) = Slot::take("nginx:1.27").unwrap();
    let err = Slot::take("redis:7").err().unwrap();
    assert!(err.contains("A scan of nginx:1.27 is running"), "{err}");
    cmd_image_scan_cancel();
    // The permit is kept for the scan's select.
    let waited = tokio::time::timeout(std::time::Duration::from_millis(100), cancel.notified())
        .await
        .is_ok();
    assert!(waited, "a cancel before the scan waits is not lost");
    drop(slot);
    assert!(Slot::take("redis:7").is_ok());
}
