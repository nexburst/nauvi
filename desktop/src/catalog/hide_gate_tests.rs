//! "Remove = hide" (ADR 0007): hiding a context, showing it again and
//! removing its source change nauvi's own settings only. The kubeconfig
//! files stay byte-identical.

use super::KubeconfigSources;
use crate::commands::catalog::remove_source;
use crate::settings::{SettingsPatch, SettingsStore};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const KUBECONFIG: &str = r#"apiVersion: v1
kind: Config
# A comment and odd spacing: any rewrite of the file would lose them.
clusters:
- name: c
  cluster:   {server: "https://127.0.0.1:1"}
users:
- name: u
  user: {token: abc}
contexts:
- name: nauvi-333-hide-a
  context: {cluster: c, user: u, namespace: demo}
- name: nauvi-333-hide-b
  context: {cluster: c, user: u}
current-context: nauvi-333-hide-a
"#;

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bytes(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out: Vec<(PathBuf, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "yaml"))
        .map(|p| {
            let b = std::fs::read(&p).unwrap();
            (p, b)
        })
        .collect();
    out.sort();
    out
}

#[test]
fn hide_unhide_and_remove_leave_the_kubeconfig_files_byte_identical() {
    let dir = Dir(std::env::temp_dir().join(format!("nauvi-333-hide-{}", std::process::id())));
    let _ = std::fs::remove_dir_all(&dir.0);
    let kube = dir.0.join("kube");
    std::fs::create_dir_all(&kube).unwrap();
    std::fs::write(kube.join("work.yaml"), KUBECONFIG).unwrap();
    std::fs::write(
        kube.join("other.yaml"),
        KUBECONFIG.replace("hide-", "other-"),
    )
    .unwrap();
    let before = bytes(&kube);
    let modified = std::fs::metadata(kube.join("work.yaml"))
        .unwrap()
        .modified()
        .unwrap();

    let settings_file = dir.0.join("config").join("settings.json");
    let store = SettingsStore::open(Some(settings_file.clone()));
    let sources = Arc::new(KubeconfigSources::default());
    let folder = kube.display().to_string();
    let next = store.modify(|s| s.kubeconfig_sources.push(folder.clone()));
    sources.set_extra(&next.kubeconfig_sources);
    let ids: Vec<String> = sources
        .catalog()
        .contexts
        .iter()
        .filter(|c| c.source == folder)
        .map(|c| c.name.clone())
        .collect();
    assert_eq!(ids.len(), 4, "{ids:?}");

    // Hide two, unhide one.
    store.update(SettingsPatch {
        hidden_contexts: Some(vec![ids[0].clone(), ids[1].clone()]),
        ..Default::default()
    });
    store.flush();
    assert_eq!(bytes(&kube), before);
    // Hidden is not gone: the catalog still lists it.
    assert!(sources.catalog().find(&ids[0]).is_some());
    store.update(SettingsPatch {
        hidden_contexts: Some(vec![ids[1].clone()]),
        ..Default::default()
    });
    store.flush();
    assert_eq!(bytes(&kube), before);

    // Remove the folder as a source: its files stay as they were.
    remove_source(&sources, &store, &folder).unwrap();
    store.flush();
    assert!(sources.catalog().find(&ids[0]).is_none());
    assert_eq!(bytes(&kube), before);
    assert_eq!(
        std::fs::metadata(kube.join("work.yaml"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    // nauvi wrote only its own settings.
    let saved = std::fs::read_to_string(&settings_file).unwrap();
    assert!(saved.contains(&ids[1]), "{saved}");
    assert!(!saved.contains("token"), "{saved}");
}
