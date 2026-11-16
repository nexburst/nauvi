//! The consent gate for added kubeconfigs' login commands (#201): what it
//! is keyed on, and every way the app reaches the cluster with the file.

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
    assert!(sources.may_log_in(id).is_err());
    sources
        .answer_exec(&added.source(), &cmds[0].command, true)
        .unwrap();
    assert_eq!(sources.may_log_in(id), Ok(()));

    // Same command and args, another PATH: asked again.
    added.write(id, "/tmp/attacker:/usr/bin");
    let err = sources.may_log_in(id).unwrap_err();
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
    let target = session.target().unwrap();
    assert_eq!(target.kubeconfig.as_deref(), Some(added.file.as_path()));
    assert_eq!(target.context, id);
}
