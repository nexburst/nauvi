//! The catalog (#78) in a temp home, without KUBECONFIG: the default
//! kubeconfig is `$HOME/.kube/config` (`%USERPROFILE%` on Windows), `~` paths expand to the temp HOME, and
//! nothing writes to the kubeconfig files, neither the temp ones nor the
//! real `~/.kube/config` of whoever runs the test (hashed before and after).
//!
//! One test in its own binary: it changes the process environment.

use nauvi::catalog::{
    default_kubeconfig_paths, expand_home, load_catalog, save_pasted_kubeconfig, CatalogInput,
    SourceKind,
};
use nauvi::{shell_kubeconfig, shell_kubeconfig_env_for};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

fn hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    Some(h.finish())
}

fn kubeconfig(name: &str, server: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Config\ncurrent-context: {name}\n\
         clusters:\n- name: c\n  cluster: {{server: \"{server}\"}}\n\
         users:\n- name: u\n  user: {{token: secret}}\n\
         contexts:\n- name: {name}\n  context: {{cluster: c, user: u}}\n"
    )
}

#[test]
fn catalog_in_a_temp_home_never_writes_kubeconfigs() {
    let real = home::home_dir().map(|h| h.join(".kube").join("config"));
    let real_before = real.as_deref().and_then(hash);

    let home = std::env::temp_dir().join(format!("nauvi-catalog-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join(".kube")).unwrap();
    std::fs::create_dir_all(home.join("work")).unwrap();
    let default = home.join(".kube").join("config");
    std::fs::write(&default, kubeconfig("dev", "https://127.0.0.1:1")).unwrap();
    let extra = home.join("work").join("prod.yaml");
    std::fs::write(&extra, kubeconfig("dev", "https://127.0.0.1:2")).unwrap();
    let files = [default.clone(), extra.clone()];
    let before: Vec<Option<u64>> = files.iter().map(|f| hash(f)).collect();

    // The only test in this binary: no other thread reads the environment.
    // Unix finds the home in HOME, Windows in USERPROFILE.
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::remove_var("KUBECONFIG");

    assert_eq!(default_kubeconfig_paths(), vec![default.clone()]);
    assert_eq!(expand_home("~/work/prod.yaml"), extra);
    let pasted_dir = home.join("app").join("kubeconfigs");
    let pasted =
        save_pasted_kubeconfig(&pasted_dir, &kubeconfig("lab", "https://127.0.0.1:3"), "").unwrap();
    let catalog = load_catalog(&CatalogInput::here(
        vec![expand_home("~/work/prod.yaml"), pasted.clone()],
        Some(pasted_dir),
    ));
    let ids: Vec<&str> = catalog.contexts.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(ids, vec!["dev", "dev (prod.yaml)", "lab"]);
    assert_eq!(catalog.sources[2].kind, SourceKind::Pasted);

    // A local shell at the added context: its temp kubeconfig picks the
    // context by its own name, and KUBECONFIG names the added file.
    let target = catalog.resolve(Some("dev (prod.yaml)")).unwrap();
    let kc = kube::config::Kubeconfig::read_from(target.kubeconfig.as_ref().unwrap()).unwrap();
    let shell = shell_kubeconfig(&kc, Some(&target.context), None).unwrap();
    assert_eq!(shell.context, "dev");
    let temp = home.join("shell.yaml");
    let env = shell_kubeconfig_env_for(&temp, target.kubeconfig.as_deref());
    assert_eq!(
        std::env::split_paths(&env).collect::<Vec<_>>(),
        vec![temp.clone(), extra.clone()]
    );
    // The default context's shell falls back to $HOME/.kube/config.
    let env = shell_kubeconfig_env_for(&temp, None);
    assert_eq!(
        std::env::split_paths(&env).collect::<Vec<_>>(),
        vec![temp.clone(), default.clone()]
    );

    let after: Vec<Option<u64>> = files.iter().map(|f| hash(f)).collect();
    assert_eq!(before, after, "a kubeconfig file in the temp HOME changed");
    std::fs::remove_dir_all(&home).unwrap();
    assert_eq!(
        real.as_deref().and_then(hash),
        real_before,
        "the real ~/.kube/config changed"
    );
}
