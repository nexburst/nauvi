//! The installers' licence page (`bundle.licenseFile`) shows
//! `desktop/bundle/license.txt`: `LICENSE` with each paragraph on one line,
//! because the DMG Agree window, the NSIS page and the MSI dialog wrap the
//! text themselves and the hard breaks in `LICENSE` broke it up (#322).
//! These tests keep the copy in step with `LICENSE`.

use std::path::Path;

fn read(path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .replace("\r\n", "\n")
}

/// `text` with the lines of each paragraph joined by a space.
fn unwrap_paragraphs(text: &str) -> String {
    let paragraphs: Vec<String> = text
        .trim()
        .split("\n\n")
        .map(|p| p.lines().map(str::trim).collect::<Vec<_>>().join(" "))
        .collect();
    paragraphs.join("\n\n") + "\n"
}

#[test]
fn bundle_license_is_license_unwrapped() {
    assert_eq!(
        read("bundle/license.txt"),
        unwrap_paragraphs(&read("../LICENSE")),
        "desktop/bundle/license.txt must be LICENSE with one line per paragraph; regenerate it after changing LICENSE"
    );
}

#[test]
fn tauri_conf_points_at_bundle_license() {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    assert_eq!(conf["bundle"]["licenseFile"], "bundle/license.txt");
}
