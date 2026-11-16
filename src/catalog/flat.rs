//! One context of an added kubeconfig, as it was read when its login
//! command was allowed (#242).
//!
//! The app checks an added file's login command against the user's answer
//! and then connects with the same parsed value, so a file swapped in
//! between cannot run another command. Helm and the local shell run outside
//! the app and would read the file again; they get [`flatten_context`]
//! instead, written to a private temp file: the context, its cluster and
//! its user, with the certificate files inlined.

use super::login_command;
use anyhow::{anyhow, Context as _, Result};
use base64::Engine as _;
use kube::config::{Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext};
use std::path::Path;

/// The command logging in to `context` of `kubeconfig` runs (`""`: none
/// or no such context), as [`login_command`] shows it.
pub fn context_login_command(kubeconfig: &Kubeconfig, context: &str) -> String {
    kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.as_deref())
        .and_then(|user| kubeconfig.auth_infos.iter().find(|a| a.name == user))
        .and_then(|a| a.auth_info.as_ref())
        .map(login_command)
        .unwrap_or_default()
}

/// `context` of `kubeconfig` (read from `file`) on its own: that context
/// as `current-context`, with only its cluster and user, like
/// `kubectl config view --minify --flatten`. The certificate files are
/// inlined, and a relative exec command with a `/` is made absolute from
/// the file's folder, as kubectl resolves it, so the copy runs what the
/// file does wherever it is written.
pub fn flatten_context(kubeconfig: &Kubeconfig, context: &str, file: &Path) -> Result<Kubeconfig> {
    let named = kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == context)
        .ok_or_else(|| anyhow!("context {context:?} is not in {}", file.display()))?;
    let entry = named
        .context
        .as_ref()
        .ok_or_else(|| anyhow!("context {context:?} in {} is empty", file.display()))?;
    let mut clusters: Vec<NamedCluster> = kubeconfig
        .clusters
        .iter()
        .filter(|c| c.name == entry.cluster)
        .take(1)
        .cloned()
        .collect();
    let mut users: Vec<NamedAuthInfo> = match entry.user.as_deref() {
        Some(user) => kubeconfig
            .auth_infos
            .iter()
            .filter(|a| a.name == user)
            .take(1)
            .cloned()
            .collect(),
        None => vec![],
    };
    for cluster in clusters.iter_mut().filter_map(|c| c.cluster.as_mut()) {
        if let Some(path) = cluster.certificate_authority.take() {
            cluster.certificate_authority_data = Some(inline(&path)?);
        }
    }
    let dir = file.parent().unwrap_or(Path::new(""));
    for user in users.iter_mut().filter_map(|u| u.auth_info.as_mut()) {
        if let Some(path) = user.client_certificate.take() {
            user.client_certificate_data = Some(inline(&path)?);
        }
        if let Some(path) = user.client_key.take() {
            user.client_key_data = Some(inline(&path)?.into());
        }
        if let Some(exec) = user.exec.as_mut() {
            if let Some(command) = exec.command.as_mut() {
                let path = Path::new(command.as_str());
                if path.is_relative() && command.contains(std::path::MAIN_SEPARATOR) {
                    *command = dir.join(path).display().to_string();
                }
            }
        }
    }
    Ok(Kubeconfig {
        api_version: Some("v1".to_string()),
        kind: Some("Config".to_string()),
        clusters,
        auth_infos: users,
        contexts: vec![NamedContext {
            name: named.name.clone(),
            context: Some(entry.clone()),
        }],
        current_context: Some(named.name.clone()),
        ..Default::default()
    })
}

/// The file at `path`, base64-encoded for a `*-data` field.
fn inline(path: &str) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("cannot read {path}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// `kubeconfig` as YAML.
pub fn kubeconfig_yaml(kubeconfig: &Kubeconfig) -> Result<String> {
    Ok(serde_yaml::to_string(kubeconfig)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = r#"
apiVersion: v1
kind: Config
current-context: other
clusters:
- name: c1
  cluster: {server: "https://one.example", certificate-authority: ca.pem}
- name: c2
  cluster: {server: "https://two.example"}
users:
- name: u1
  user:
    client-certificate: certs/crt.pem
    client-key: certs/key.pem
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: ./bin/get-token
      args: [--profile, a]
      env:
      - {name: PATH, value: /usr/bin}
- name: u2
  user: {token: secret-two}
contexts:
- name: one
  context: {cluster: c1, user: u1, namespace: orig}
- name: other
  context: {cluster: c2, user: u2}
"#;

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn written(tag: &str) -> (Dir, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("kubeloupe-242-flat-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("certs")).unwrap();
        std::fs::write(dir.join("ca.pem"), "CA").unwrap();
        std::fs::write(dir.join("certs/crt.pem"), "CRT").unwrap();
        std::fs::write(dir.join("certs/key.pem"), "KEY").unwrap();
        let file = dir.join("team.yaml");
        std::fs::write(&file, FILE).unwrap();
        (Dir(dir), file)
    }

    #[test]
    fn login_command_of_a_context() {
        let kc = Kubeconfig::from_yaml(FILE).unwrap();
        assert_eq!(
            context_login_command(&kc, "one"),
            "env PATH=/usr/bin ./bin/get-token --profile a"
        );
        assert_eq!(context_login_command(&kc, "other"), "");
        assert_eq!(context_login_command(&kc, "missing"), "");
    }

    #[test]
    fn only_the_context_its_cluster_and_user_inlined() {
        let (dir, file) = written("inlined");
        let kc = Kubeconfig::read_from(&file).unwrap();
        let flat = flatten_context(&kc, "one", &file).unwrap();
        // It reads back as the same context, on its own.
        let back = Kubeconfig::from_yaml(&kubeconfig_yaml(&flat).unwrap()).unwrap();
        assert_eq!(back.current_context.as_deref(), Some("one"));
        assert_eq!(back.contexts.len(), 1);
        assert_eq!(back.clusters.len(), 1);
        assert_eq!(back.auth_infos.len(), 1);
        let ctx = back.contexts[0].context.as_ref().unwrap();
        assert_eq!(ctx.namespace.as_deref(), Some("orig"));
        let cluster = back.clusters[0].cluster.as_ref().unwrap();
        assert_eq!(cluster.server.as_deref(), Some("https://one.example"));
        assert_eq!(cluster.certificate_authority, None);
        assert_eq!(cluster.certificate_authority_data.as_deref(), Some("Q0E="));
        let user = back.auth_infos[0].auth_info.as_ref().unwrap();
        assert_eq!(
            (user.client_certificate.as_ref(), user.client_key.as_ref()),
            (None, None)
        );
        assert_eq!(user.client_certificate_data.as_deref(), Some("Q1JU"));
        assert!(user.client_key_data.is_some());
        assert!(kubeconfig_yaml(&flat)
            .unwrap()
            .contains("client-key-data: S0VZ"));
        let exec = user.exec.as_ref().unwrap();
        // kubectl resolves it only with the platform's separator in it.
        let command = if cfg!(windows) {
            "./bin/get-token".to_string()
        } else {
            dir.0.join("./bin/get-token").display().to_string()
        };
        assert_eq!(exec.command.as_deref(), Some(command.as_str()));
        assert_eq!(
            exec.args.as_deref(),
            Some(&["--profile".to_string(), "a".to_string()][..])
        );
        assert!(!kubeconfig_yaml(&flat).unwrap().contains("secret-two"));
    }

    #[test]
    fn missing_context_or_file_is_an_error() {
        let (dir, file) = written("missing");
        let kc = Kubeconfig::read_from(&file).unwrap();
        let err = flatten_context(&kc, "nope", &file).unwrap_err().to_string();
        assert!(err.starts_with("context \"nope\" is not in "), "{err}");
        std::fs::remove_file(dir.0.join("ca.pem")).unwrap();
        let err = format!("{:#}", flatten_context(&kc, "one", &file).unwrap_err());
        assert!(err.starts_with("cannot read "), "{err}");
    }
}
