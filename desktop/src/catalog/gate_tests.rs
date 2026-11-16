//! The consent gate for added kubeconfigs' login commands (#201): what it
//! is keyed on, and every way the app reaches the cluster with the file.
//! A file swapped after the check is not read again (#242).

use super::KubeconfigSources;
use crate::state::ClusterSession;
use std::path::PathBuf;
use std::sync::Arc;

/// A temp dir with an added kubeconfig whose user runs `aws` with `env`.
struct Added {
    dir: PathBuf,
    file: PathBuf,
}

impl Added {
    fn new(tag: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("kubeloupe-201-gate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("eks.yaml");
        Self { dir, file }
    }

    /// Write the kubeconfig with context `id`, its plugin's `PATH` set to `path`.
    fn write(&self, id: &str, path: &str) {
        std::fs::write(
            &self.file,
            format!(
                r#"apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {{server: "https://127.0.0.1:1"}}
users:
- name: u
  user:
    exec:
      command: aws
      args: [eks, get-token]
      env:
      - {{name: PATH, value: "{path}"}}
contexts:
- name: {id}
  context: {{cluster: c, user: u}}
"#
            ),
        )
        .unwrap();
    }

    fn sources(&self) -> Arc<KubeconfigSources> {
        // No pasted dir: the answers last this test only, nothing is saved.
        let sources = Arc::new(KubeconfigSources::default());
        sources.set_extra(&[self.file.display().to_string()]);
        sources
    }

    fn source(&self) -> String {
        self.file.display().to_string()
    }
}

/// Whether context `id` may log in, as a message.
fn gate(sources: &KubeconfigSources, id: &str) -> Result<(), String> {
    sources.approved(Some(id)).map(|_| ()).map_err(String::from)
}

impl Drop for Added {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn changing_only_the_env_needs_a_new_answer() {
    let id = "kl-201-gate-env";
    let added = Added::new("env");
    added.write(id, "/usr/bin:/bin");
    let sources = added.sources();
    let cmds = sources.exec_commands(&added.source());
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].command, "env PATH=/usr/bin:/bin aws eks get-token");
    assert!(gate(&sources, id).is_err());
    sources
        .answer_exec(&added.source(), &cmds[0].command, true)
        .unwrap();
    assert_eq!(gate(&sources, id), Ok(()));

    // Same command and args, another PATH: asked again.
    added.write(id, "/tmp/attacker:/usr/bin");
    let err = gate(&sources, id).unwrap_err();
    assert!(err.contains("env PATH=/tmp/attacker:/usr/bin aws"), "{err}");
    assert!(err.contains("not allowed it yet"), "{err}");
    let cmds = sources.exec_commands(&added.source());
    assert_eq!(cmds[0].answer, super::ExecAnswer::Unanswered);
}

#[test]
fn helm_and_local_shells_get_the_file_only_once_allowed() {
    let id = "kl-201-gate-target";
    let added = Added::new("target");
    added.write(id, "/usr/bin:/bin");
    let sources = added.sources();
    let session = ClusterSession::new(Some(id.to_string()), sources.clone());
    // `target()` is what helm and local shells run with.
    let err = session.target().unwrap_err();
    assert!(
        err.starts_with("Login to `kl-201-gate-target` was not started"),
        "{err}"
    );

    let command = sources.exec_commands(&added.source())[0].command.clone();
    sources
        .answer_exec(&added.source(), &command, false)
        .unwrap();
    assert!(session
        .target()
        .unwrap_err()
        .contains("you chose not to run it"));

    sources
        .answer_exec(&added.source(), &command, true)
        .unwrap();
    let approved = session.target().unwrap();
    assert_eq!(
        approved.target.kubeconfig.as_deref(),
        Some(added.file.as_path())
    );
    assert_eq!(approved.target.context, id);
    assert!(approved.kubeconfig.is_some());
}

/// An added kubeconfig whose plugin is `sh -c 'echo <tag> >> <marker>'`.
/// The plugin prints no credential, so logging in fails after it ran.
fn write_plugin(added: &Added, id: &str, tag: &str) {
    let marker = added.dir.join("ran");
    std::fs::write(
        &added.file,
        format!(
            r#"apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {{server: "https://127.0.0.1:1"}}
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: /bin/sh
      args: [-c, "echo {tag} >> {marker}"]
      interactiveMode: Never
contexts:
- name: {id}
  context: {{cluster: c, user: u}}
"#,
            marker = marker.display()
        ),
    )
    .unwrap();
}

/// Allow the one login command of `added`, written by [`write_plugin`].
fn allow(added: &Added, sources: &KubeconfigSources) -> String {
    let command = sources.exec_commands(&added.source())[0].command.clone();
    sources
        .answer_exec(&added.source(), &command, true)
        .unwrap();
    command
}

fn ran(added: &Added) -> String {
    std::fs::read_to_string(added.dir.join("ran")).unwrap_or_default()
}

#[cfg(unix)]
#[tokio::test]
async fn the_client_runs_the_command_that_was_checked() {
    let id = "kl-242-swap-client";
    let added = Added::new("swap-client");
    write_plugin(&added, id, "allowed");
    let sources = added.sources();
    allow(&added, &sources);
    let approved = sources.approved(Some(id)).unwrap();
    // Swapped between the check and the connect.
    write_plugin(&added, id, "swapped");
    assert!(approved.client().await.is_err());
    assert_eq!(ran(&added), "allowed\n");
    // Asked again, the swapped file is not allowed, and nothing runs.
    let err = gate(&sources, id).unwrap_err();
    assert!(err.contains("swapped"), "{err}");
    let session = ClusterSession::new(Some(id.to_string()), sources.clone());
    assert!(session.client().await.is_err());
    assert_eq!(ran(&added), "allowed\n");
}

#[test]
fn helm_gets_a_copy_of_the_checked_context() {
    let id = "kl-242-swap-helm";
    let added = Added::new("swap-helm");
    write_plugin(&added, id, "allowed");
    let sources = added.sources();
    let command = allow(&added, &sources);
    let session = ClusterSession::new(Some(id.to_string()), sources.clone());
    let run = crate::commands::helm::target(&session).unwrap();
    write_plugin(&added, id, "swapped");
    let path = run.kubeconfig.clone().unwrap();
    assert_ne!(path, added.file);
    assert_eq!(run.context.as_deref(), Some(id));
    let copy = kube::config::Kubeconfig::read_from(&path).unwrap();
    assert_eq!(
        kubeloupe::catalog::context_login_command(&copy, id),
        command
    );
    assert!(!std::fs::read_to_string(&path).unwrap().contains("swapped"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    drop(run);
    assert!(!path.exists());
    // The next helm command checks the swapped file, and refuses it.
    assert!(crate::commands::helm::target(&session).is_err());
}

#[test]
fn a_local_shell_gets_only_a_copy_of_the_checked_context() {
    let id = "kl-242-swap-shell";
    let added = Added::new("swap-shell");
    write_plugin(&added, id, "allowed");
    let sources = added.sources();
    let command = allow(&added, &sources);
    let session = ClusterSession::new(Some(id.to_string()), sources.clone());
    let approved = session.target().unwrap();
    let (shell, temp, env) =
        crate::commands::local_shell::shell_kubeconfig_for(&approved, Some("team-a")).unwrap();
    write_plugin(&added, id, "swapped");
    // KUBECONFIG is the copy alone: kubectl never reads the added file.
    assert_eq!(env, temp.path().as_os_str());
    assert_eq!(
        (shell.context.as_str(), shell.namespace.as_str()),
        (id, "team-a")
    );
    let copy = kube::config::Kubeconfig::read_from(temp.path()).unwrap();
    assert_eq!(
        kubeloupe::catalog::context_login_command(&copy, id),
        command
    );
    assert_eq!(copy.current_context.as_deref(), Some(id));
    assert!(!std::fs::read_to_string(temp.path())
        .unwrap()
        .contains("swapped"));
}
