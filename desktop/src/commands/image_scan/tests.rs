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

/// The only test that sets `NAUVI_TRIVY` (nothing else in the app reads
/// it): the whole approval flow on a fake trivy.
#[cfg(unix)]
#[tokio::test]
async fn approve_once_ask_again_when_it_changes_refuse_bad_versions() {
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

    // Only the file found now can be approved.
    let err = approve(&d, ScannerKind::Trivy, "/usr/bin/evil")
        .await
        .unwrap_err();
    assert!(err.contains("is not the trivy nauvi finds now"), "{err}");
    let s = approve(&d, ScannerKind::Trivy, &real).await.unwrap();
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

    // A malicious release: refused, and the approval is dropped.
    script(&trivy, &version("0.69.4"));
    let s = approve(&d, ScannerKind::Trivy, &real).await.unwrap();
    assert_eq!(s.state, ScannerState::Refused, "{s:?}");
    assert!(s.message.contains("CVE-2026-33634"));
    assert_eq!(approval::approved(&d.approvals(), ScannerKind::Trivy), None);
    let (s, _) = scanner_status(&d, ScannerKind::Trivy, false).await;
    assert_eq!(s.state, ScannerState::Unapproved);

    // Another path than the approved one.
    script(&trivy, &version("0.58.1"));
    approve(&d, ScannerKind::Trivy, &real).await.unwrap();
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
