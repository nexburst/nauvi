//! Which login commands of added kubeconfigs the user allowed (#201).
//!
//! A kubeconfig's `exec` plugin (or gcp auth provider) is a command the app
//! runs to log in. For the default kubeconfig that is the user's own setup,
//! as kubectl runs it. A file, folder or pasted kubeconfig added in the app
//! may come from anyone, so its commands run only once the user saw them
//! and said yes. The answers are kept per source and command line, in
//! `exec-approvals.json` in the app's config directory: a changed command
//! is a new question.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The user's answer for one command of one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecAnswer {
    /// Not asked yet (or the source was added again).
    Unanswered,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Answer {
    source: String,
    command: String,
    allowed: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Approvals {
    answers: Vec<Answer>,
    /// Where they are saved (`None`: kept for this session only).
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl Approvals {
    /// The answers saved at `path` (none if it is missing or unreadable).
    pub(crate) fn load(path: Option<PathBuf>) -> Self {
        let mut a: Approvals = path
            .as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        a.path = path;
        a
    }

    pub(crate) fn answer(&self, source: &str, command: &str) -> ExecAnswer {
        match self
            .answers
            .iter()
            .find(|a| a.source == source && a.command == command)
        {
            Some(a) if a.allowed => ExecAnswer::Allowed,
            Some(_) => ExecAnswer::Denied,
            None => ExecAnswer::Unanswered,
        }
    }

    pub(crate) fn set(&mut self, source: &str, command: &str, allowed: bool) -> Result<(), String> {
        self.answers
            .retain(|a| !(a.source == source && a.command == command));
        self.answers.push(Answer {
            source: source.to_string(),
            command: command.to_string(),
            allowed,
        });
        self.save()
    }

    /// Forget every answer for `source` (it was removed).
    pub(crate) fn forget_source(&mut self, source: &str) -> Result<(), String> {
        let before = self.answers.len();
        self.answers.retain(|a| a.source != source);
        if self.answers.len() == before {
            return Ok(());
        }
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        write_private(path, &serde_json::to_vec_pretty(self).unwrap_or_default())
            .map_err(|e| format!("Could not save the answer in {}: {e}", path.display()))
    }
}

/// Write `bytes` to `path` atomically (a temp file renamed over it), readable
/// only by the user.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// The message for a context whose login command is not allowed (yet). It
/// starts like every failed login, so a window shows "Login failed".
pub(crate) fn not_allowed_message(
    id: &str,
    command: &str,
    source: &str,
    answer: ExecAnswer,
) -> String {
    let why = if answer == ExecAnswer::Denied {
        "you chose not to run it"
    } else {
        "you have not allowed it yet"
    };
    format!(
        "{}{id}` was not started: it runs `{command}` (from {source}), and {why}. \
         Open the cluster catalog and choose Check to allow it.",
        kubeloupe::auth::LOGIN_FAILED
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_kept_per_source_and_command() {
        let dir =
            std::env::temp_dir().join(format!("kubeloupe-201-approvals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("exec-approvals.json");
        let mut a = Approvals::load(Some(path.clone()));
        assert_eq!(
            a.answer("/k/a.yaml", "aws eks get-token"),
            ExecAnswer::Unanswered
        );
        a.set("/k/a.yaml", "aws eks get-token", true).unwrap();
        a.set("/k/a.yaml", "sh -c evil", false).unwrap();
        a.set("/k/b.yaml", "aws eks get-token", false).unwrap();

        let mut b = Approvals::load(Some(path.clone()));
        assert_eq!(
            b.answer("/k/a.yaml", "aws eks get-token"),
            ExecAnswer::Allowed
        );
        assert_eq!(b.answer("/k/a.yaml", "sh -c evil"), ExecAnswer::Denied);
        assert_eq!(
            b.answer("/k/b.yaml", "aws eks get-token"),
            ExecAnswer::Denied
        );
        // A changed command line is a new question.
        assert_eq!(
            b.answer("/k/a.yaml", "aws eks get-token --x"),
            ExecAnswer::Unanswered
        );
        // A new answer replaces the old one.
        b.set("/k/b.yaml", "aws eks get-token", true).unwrap();
        assert_eq!(
            b.answer("/k/b.yaml", "aws eks get-token"),
            ExecAnswer::Allowed
        );
        b.forget_source("/k/a.yaml").unwrap();

        let c = Approvals::load(Some(path.clone()));
        assert_eq!(
            c.answer("/k/a.yaml", "aws eks get-token"),
            ExecAnswer::Unanswered
        );
        assert_eq!(
            c.answer("/k/b.yaml", "aws eks get-token"),
            ExecAnswer::Allowed
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_message_reads_as_a_failed_login() {
        let m = not_allowed_message(
            "eks",
            "aws eks get-token",
            "/k/a.yaml",
            ExecAnswer::Unanswered,
        );
        assert!(m.starts_with("Login to `eks` was not started"), "{m}");
        assert!(m.contains("`aws eks get-token` (from /k/a.yaml)"), "{m}");
        let m = not_allowed_message("eks", "aws", "/k/a.yaml", ExecAnswer::Denied);
        assert!(m.contains("you chose not to run it"), "{m}");
    }
}
