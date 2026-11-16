use super::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

/// A fresh temp directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kubeloupe-catalog-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A kubeconfig with the given contexts, each on its own cluster
/// `c-<name>` at `https://<name>.example`.
fn kubeconfig(current: &str, names: &[&str]) -> String {
    let mut s = format!("apiVersion: v1\nkind: Config\ncurrent-context: {current:?}\nclusters:\n");
    for n in names {
        s += &format!("- name: c-{n}\n  cluster: {{server: \"https://{n}.example\"}}\n");
    }
    s += "users:\n- name: u\n  user: {token: secret}\ncontexts:\n";
    for n in names {
        s += &format!("- name: {n:?}\n  context: {{cluster: c-{n}, user: u, namespace: ns-{n}}}\n");
    }
    s
}

fn ids(c: &Catalog) -> Vec<&str> {
    c.contexts.iter().map(|c| c.name.as_str()).collect()
}

#[test]
fn default_files_merge_first_wins_and_keep_their_names() {
    let dir = TempDir::new();
    let a = dir.write("a", &kubeconfig("one", &["one", "shared"]));
    let b = dir.write("b", &kubeconfig("two", &["two", "shared"]));
    let c = load_catalog(&CatalogInput {
        default_paths: vec![a.clone(), b.clone()],
        ..Default::default()
    });
    // `shared` is in both: listed once, from the first file, like kubectl.
    assert_eq!(ids(&c), vec!["one", "shared", "two"]);
    assert_eq!(c.current_context, "one");
    let shared = c.find("shared").unwrap();
    assert_eq!(shared.file, a.display().to_string());
    assert_eq!(shared.source, "");
    assert_eq!(shared.server, "https://shared.example");
    assert_eq!(shared.user, "u");
    assert_eq!(shared.namespace.as_deref(), Some("ns-shared"));
    assert!(c.find("one").unwrap().current);
    assert!(!c.find("two").unwrap().current);
    assert_eq!(c.sources.len(), 2);
    assert!(c.sources.iter().all(|s| s.kind == SourceKind::Kubeconfig));
    // Default contexts connect through the default kubeconfig.
    assert_eq!(
        c.resolve(Some("two")).unwrap(),
        ContextTarget {
            id: "two".into(),
            context: "two".into(),
            kubeconfig: None
        }
    );
    assert_eq!(c.resolve(None).unwrap().context, "one");
}

#[test]
fn clashing_names_from_added_files_are_disambiguated() {
    let dir = TempDir::new();
    let default = dir.write("home/config", &kubeconfig("dev", &["dev", "prod"]));
    let extra = dir.write("work/team.yaml", &kubeconfig("prod", &["prod", "staging"]));
    let other = dir.write("other/team.yaml", &kubeconfig("prod", &["prod"]));
    let c = load_catalog(&CatalogInput {
        default_paths: vec![default],
        extra: vec![extra.clone(), other.clone()],
        pasted_dir: None,
    });
    let other_id = format!("prod ({})", other.display());
    assert_eq!(
        ids(&c),
        vec!["dev", "prod", "prod (team.yaml)", "staging", &other_id]
    );
    // An added file's contexts connect with that file only, by their own name.
    let t = c.resolve(Some("prod (team.yaml)")).unwrap();
    assert_eq!(t.context, "prod");
    assert_eq!(t.kubeconfig.as_deref(), Some(extra.as_path()));
    assert_eq!(
        c.resolve(Some(&other_id)).unwrap().kubeconfig.as_deref(),
        Some(other.as_path())
    );
    let staging = c.find("staging").unwrap();
    assert_eq!(staging.source, extra.display().to_string());
    assert!(!staging.current);
    let err = c.resolve(Some("gone")).unwrap_err().to_string();
    assert!(err.contains("`gone` is not in the kubeconfig"), "{err}");
}

#[test]
fn ids_are_unique_and_stable() {
    let mut used = HashSet::new();
    let f = Path::new("/k/a.yaml");
    assert_eq!(unique_id(&mut used, "x", f), "x");
    assert_eq!(unique_id(&mut used, "x", f), "x (a.yaml)");
    assert_eq!(unique_id(&mut used, "x", f), "x (/k/a.yaml)");
    assert_eq!(unique_id(&mut used, "x", f), "x (/k/a.yaml) #2");
    // A name that looks like a disambiguated id is not taken twice.
    assert_eq!(unique_id(&mut used, "x (a.yaml)", f), "x (a.yaml) (a.yaml)");
}

#[test]
fn folders_read_every_kubeconfig_and_skip_the_rest() {
    let dir = TempDir::new();
    dir.write("kc/b.yaml", &kubeconfig("b", &["b"]));
    dir.write("kc/a.yaml", &kubeconfig("a", &["a1", "a2"]));
    dir.write("kc/README.md", "# not: [a kubeconfig");
    dir.write("kc/.hidden", &kubeconfig("h", &["hidden"]));
    dir.write("kc/empty.yaml", "apiVersion: v1\nkind: Config\n");
    dir.write("kc/sub/c.yaml", &kubeconfig("c", &["c"]));
    let c = load_catalog(&CatalogInput {
        default_paths: vec![dir.0.join("missing")],
        extra: vec![dir.0.join("kc")],
        pasted_dir: None,
    });
    assert_eq!(ids(&c), vec!["a1", "a2", "b"]);
    let folder = &c.sources[1];
    assert_eq!(folder.kind, SourceKind::Folder);
    assert_eq!((folder.files, folder.contexts), (2, 3));
    assert_eq!(folder.error, "");
    // The missing default file is reported, not fatal.
    assert_eq!(c.sources[0].error, "the file does not exist");
    assert_eq!(c.current_context, "");
    assert!(c.resolve(None).is_err());
}

#[test]
fn a_file_added_twice_is_read_once() {
    let dir = TempDir::new();
    let default = dir.write("config", &kubeconfig("dev", &["dev"]));
    let c = load_catalog(&CatalogInput {
        default_paths: vec![default.clone()],
        extra: vec![default, dir.0.clone()],
        pasted_dir: None,
    });
    assert_eq!(ids(&c), vec!["dev"]);
    assert_eq!(c.sources.len(), 3);
}

#[test]
fn unreadable_added_files_say_why() {
    let dir = TempDir::new();
    let bad = dir.write("bad.yaml", "contexts: {not: a list}");
    let c = load_catalog(&CatalogInput {
        default_paths: vec![],
        extra: vec![bad, dir.0.join("nope.yaml")],
        pasted_dir: None,
    });
    assert!(c.contexts.is_empty());
    assert!(!c.sources[0].error.is_empty());
    assert!(
        c.sources[1].error.contains("nope.yaml"),
        "{:?}",
        c.sources[1]
    );
    assert_eq!(c.sources[1].kind, SourceKind::File);
}

#[test]
fn pasted_kubeconfigs_are_private_files_of_the_app() {
    let dir = TempDir::new();
    let pasted_dir = dir.0.join("app/kubeconfigs");
    let yaml = kubeconfig("pasted", &["pasted"]);
    let first = save_pasted_kubeconfig(&pasted_dir, &yaml, "").unwrap();
    assert_eq!(first, pasted_dir.join("pasted.yaml"));
    let second = save_pasted_kubeconfig(&pasted_dir, &yaml, "My cluster/1").unwrap();
    assert_eq!(second, pasted_dir.join("My-cluster-1.yaml"));
    let third = save_pasted_kubeconfig(&pasted_dir, &yaml, "").unwrap();
    assert_eq!(third, pasted_dir.join("pasted-2.yaml"));
    assert_eq!(std::fs::read_to_string(&first).unwrap(), yaml);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&first), 0o600);
        assert_eq!(mode(&pasted_dir), 0o700);
    }

    let c = load_catalog(&CatalogInput {
        default_paths: vec![],
        extra: vec![first, second],
        pasted_dir: Some(pasted_dir.clone()),
    });
    assert_eq!(ids(&c), vec!["pasted", "pasted (My-cluster-1.yaml)"]);
    assert!(c.sources.iter().all(|s| s.kind == SourceKind::Pasted));

    let err = save_pasted_kubeconfig(&pasted_dir, "hello: [", "").unwrap_err();
    assert!(
        err.to_string()
            .starts_with("The pasted text is not a kubeconfig"),
        "{err}"
    );
    // The message names the line, never quotes it (#252).
    let secret = "users:\n- name: u\n  user:\n    token: s3cret-tok\n\tbad: x\n";
    let err = save_pasted_kubeconfig(&pasted_dir, secret, "").unwrap_err();
    assert!(!err.to_string().contains("s3cret"), "{err}");
    assert!(err.to_string().contains("line 4"), "{err}");
    let file = dir.write("secret.yaml", secret);
    let err = check_source(&file).unwrap_err();
    assert!(!err.to_string().contains("s3cret"), "{err}");
    let err =
        save_pasted_kubeconfig(&pasted_dir, "apiVersion: v1\nkind: Config\n", "").unwrap_err();
    assert_eq!(err.to_string(), "The pasted kubeconfig has no contexts.");
    assert_eq!(std::fs::read_dir(&pasted_dir).unwrap().count(), 3);
}

#[test]
fn sources_are_checked_before_they_are_added() {
    let dir = TempDir::new();
    let good = dir.write("good.yaml", &kubeconfig("g", &["g"]));
    let empty = dir.write("empty.yaml", "apiVersion: v1\nkind: Config\n");
    assert!(check_source(&good).is_ok());
    assert!(check_source(&dir.0).is_ok());
    assert!(check_source(&empty)
        .unwrap_err()
        .to_string()
        .ends_with("has no contexts"));
    assert!(check_source(&dir.0.join("nope")).is_err());
}

#[test]
fn the_fingerprint_follows_the_files() {
    let dir = TempDir::new();
    let file = dir.write("a.yaml", &kubeconfig("a", &["a"]));
    let folder = dir.0.join("kc");
    std::fs::create_dir_all(&folder).unwrap();
    let paths = vec![file.clone(), folder.clone()];
    let before = sources_fingerprint(&paths);
    assert_eq!(before, sources_fingerprint(&paths));
    dir.write("kc/b.yaml", &kubeconfig("b", &["b"]));
    let added = sources_fingerprint(&paths);
    assert_ne!(before, added);
    std::fs::write(&file, kubeconfig("a", &["a", "a2"])).unwrap();
    assert_ne!(added, sources_fingerprint(&paths));
}

fn hash_file(path: &Path) -> u64 {
    let mut h = DefaultHasher::new();
    std::fs::read(path).unwrap().hash(&mut h);
    std::fs::metadata(path).unwrap().len().hash(&mut h);
    h.finish()
}

/// The user's kubeconfig files are only ever read: listing, resolving and
/// building a shell kubeconfig leave them byte for byte as they were.
#[test]
fn the_users_files_are_never_written() {
    let dir = TempDir::new();
    let default = dir.write("home/.kube/config", &kubeconfig("dev", &["dev", "prod"]));
    let extra = dir.write("work/prod.yaml", &kubeconfig("prod", &["prod"]));
    dir.write("folder/x.yaml", &kubeconfig("x", &["x"]));
    let files = [default.clone(), extra.clone(), dir.0.join("folder/x.yaml")];
    let before: Vec<u64> = files.iter().map(|f| hash_file(f)).collect();

    let input = CatalogInput {
        default_paths: vec![default],
        extra: vec![extra, dir.0.join("folder")],
        pasted_dir: Some(dir.0.join("app")),
    };
    let c = load_catalog(&input);
    for ctx in &c.contexts {
        let t = c.resolve(Some(&ctx.name)).unwrap();
        let kc = match &t.kubeconfig {
            Some(p) => Kubeconfig::read_from(p).unwrap(),
            None => Kubeconfig::read_from(&input.default_paths[0]).unwrap(),
        };
        crate::shell_kubeconfig(&kc, Some(&t.context), Some("team-a")).unwrap();
    }
    sources_fingerprint(&input.extra);
    let after: Vec<u64> = files.iter().map(|f| hash_file(f)).collect();
    assert_eq!(before, after);
}

#[test]
fn invisible_characters_are_shown_as_escapes() {
    // Plain words and ordinary quoting are unchanged.
    assert_eq!(shell_word("aws"), "aws");
    assert_eq!(shell_word("my cluster"), "'my cluster'");
    assert_eq!(shell_word("it's"), r"'it'\''s'");
    // Newlines can't push the rest out of view.
    let padded = format!("x{}LD_PRELOAD=/evil.so", "\n".repeat(300));
    let shown = shell_word(&padded);
    assert!(!shown.contains('\n'), "{shown}");
    assert!(shown.starts_with(r"$'x\n\n"), "{shown}");
    assert!(shown.ends_with(r"LD_PRELOAD=/evil.so'"), "{shown}");
    // Bidi controls, zero-width and other format characters are escaped.
    assert_eq!(
        shell_word("a\u{202e}b\u{2066}c\u{2069}d\u{200b}e"),
        r"$'a\u202eb\u2066c\u2069d\u200be'"
    );
    assert_eq!(
        shell_word("tab\there\r\u{7}\u{e0041}"),
        r"$'tab\there\r\u0007\U000e0041'"
    );
    assert_eq!(shell_word("q'\\\n"), r"$'q\'\\\n'");
    for s in [padded.as_str(), "a\u{202e}b", "x\u{feff}\u{2028}y"] {
        let shown = shell_word(s);
        assert!(
            !shown
                .chars()
                .any(|c| c.is_control() || matches!(c as u32, 0x200B..=0x206F | 0xFEFF)),
            "{shown:?}"
        );
    }
}

#[test]
fn an_args_or_env_trick_shows_in_the_login_command() {
    let auth: kube::config::AuthInfo = serde_json::from_value(serde_json::json!({
        "exec": {
            "command": "aws",
            "args": ["eks", "get-token\u{202e}"],
            "env": [{"name": "X", "value": format!("ok{}", "\n".repeat(200))},
                    {"name": "LD_PRELOAD", "value": "/tmp/evil.so"}],
        }
    }))
    .unwrap();
    let cmd = login_command(&auth);
    assert!(!cmd.contains('\n') && !cmd.contains('\u{202e}'), "{cmd:?}");
    assert!(
        cmd.starts_with("env LD_PRELOAD=/tmp/evil.so X=$'ok\\n"),
        "{cmd}"
    );
    assert!(cmd.ends_with(r"aws eks $'get-token\u202e'"), "{cmd}");
}

#[test]
fn contexts_say_what_logging_in_runs() {
    let dir = TempDir::new();
    let file = dir.write(
        "eks.yaml",
        r#"apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: "https://eks.example"}
users:
- name: aws
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, "my cluster"]
- name: aws-env
  user:
    exec:
      command: aws
      args: [eks, get-token]
      env:
      - {name: PATH, value: "/attacker dir"}
      - {name: AWS_PROFILE, value: prod}
- name: gke
  user:
    auth-provider:
      name: gcp
      config: {cmd-path: /usr/bin/gcloud, cmd-args: config config-helper --format=json}
- name: oidc
  user:
    auth-provider: {name: oidc, config: {}}
- name: plain
  user: {token: t}
contexts:
- name: eks
  context: {cluster: c, user: aws}
- name: eks-env
  context: {cluster: c, user: aws-env}
- name: gke
  context: {cluster: c, user: gke}
- name: oidc
  context: {cluster: c, user: oidc}
- name: plain
  context: {cluster: c, user: plain}
"#,
    );
    let c = load_catalog(&CatalogInput {
        extra: vec![file],
        ..Default::default()
    });
    let eks = c.find("eks").unwrap();
    assert_eq!(
        eks.login_command,
        "aws eks get-token --cluster-name 'my cluster'"
    );
    assert!(eks.login_plugin);
    // The env is shown (names sorted, values quoted): it changes what runs.
    assert_eq!(
        c.find("eks-env").unwrap().login_command,
        "env AWS_PROFILE=prod PATH='/attacker dir' aws eks get-token"
    );
    let gke = c.find("gke").unwrap();
    assert_eq!(
        gke.login_command,
        "/usr/bin/gcloud config config-helper --format=json"
    );
    assert!(gke.login_plugin);
    let oidc = c.find("oidc").unwrap();
    assert_eq!(oidc.login_command, "");
    assert!(oidc.login_plugin);
    let plain = c.find("plain").unwrap();
    assert_eq!(plain.login_command, "");
    assert!(!plain.login_plugin);
}

#[test]
fn added_contexts_say_which_local_files_they_send() {
    let dir = TempDir::new();
    let text = r#"apiVersion: v1
kind: Config
current-context: stolen
clusters:
- name: c
  cluster: {server: "https://attacker.example"}
users:
- name: thief
  user: {tokenFile: ../secrets/token, client-key: key.pem}
- name: own
  user: {client-certificate: crt.pem}
contexts:
- name: stolen
  context: {cluster: c, user: thief}
- name: own
  context: {cluster: c, user: own}
"#;
    dir.write("secrets/token", "TOKEN");
    dir.write("added/key.pem", "KEY");
    dir.write("added/crt.pem", "CRT");
    let added = dir.write("added/team.yaml", text);
    let default = dir.write("default/config", text);
    let c = load_catalog(&CatalogInput {
        default_paths: vec![default],
        extra: vec![added.clone()],
        ..Default::default()
    });
    // The default kubeconfig is checked as before (#244).
    assert!(c.find("stolen").unwrap().local_files.is_empty());
    let token = added.parent().unwrap().join("../secrets/token");
    assert_eq!(
        c.find("stolen (team.yaml)").unwrap().local_files,
        vec![token.display().to_string()]
    );
    assert!(c.find("own (team.yaml)").unwrap().local_files.is_empty());
}
