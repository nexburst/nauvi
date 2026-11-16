//! The catalog's status column: can kubeloupe log in to a context's
//! cluster right now?

use super::ContextTarget;
use crate::auth::{CERTIFICATE_PROBLEM, LOGIN_FAILED, UNREACHABLE};
use crate::client::client_for_target;
use serde::Serialize;
use std::time::Duration;

/// Give up on a cluster that has not answered after this long.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ContextState {
    Connected,
    /// The credentials or the exec plugin failed.
    AuthError,
    CertificateError,
    Unreachable,
    /// The kubeconfig entry itself is broken (no cluster, unreadable file).
    Invalid,
    /// Logging in runs a command of an added kubeconfig that the user has
    /// not allowed (set by the desktop app, #201).
    NotAllowed,
}

/// The result of checking one context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ContextCheck {
    /// The context id.
    pub name: String,
    pub state: ContextState,
    /// The error (`""` when connected).
    pub message: String,
    /// The API server's version (`""` unless connected).
    pub version: String,
}

/// The state an error message from building a client stands for.
pub fn classify(message: &str) -> ContextState {
    if message.starts_with(LOGIN_FAILED) {
        ContextState::AuthError
    } else if message.starts_with(CERTIFICATE_PROBLEM) {
        ContextState::CertificateError
    } else if message.starts_with(UNREACHABLE) {
        ContextState::Unreachable
    } else {
        ContextState::Invalid
    }
}

/// Log in to the context's cluster (never prompting) and ask its version.
pub async fn check_context(target: &ContextTarget) -> ContextCheck {
    let attempt = async {
        let client = client_for_target(target, false).await?;
        let version = client.apiserver_version().await?;
        anyhow::Ok(version.git_version)
    };
    let (state, message, version) = match tokio::time::timeout(CHECK_TIMEOUT, attempt).await {
        Ok(Ok(version)) => (ContextState::Connected, String::new(), version),
        Ok(Err(e)) => {
            let message = format!("{e:#}");
            (classify(&message), message, String::new())
        }
        Err(_) => (
            ContextState::Unreachable,
            format!(
                "{UNREACHABLE} for `{}`: no answer within {} s",
                target.id,
                CHECK_TIMEOUT.as_secs()
            ),
            String::new(),
        ),
    };
    ContextCheck {
        name: target.id.clone(),
        state,
        message,
        version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_classified_by_prefix() {
        assert_eq!(
            classify("Login to `x` failed: nope"),
            ContextState::AuthError
        );
        assert_eq!(
            classify("Certificate problem connecting"),
            ContextState::CertificateError
        );
        assert_eq!(
            classify("Cannot reach the cluster for `x`"),
            ContextState::Unreachable
        );
        assert_eq!(classify("cannot read kubeconfig /x"), ContextState::Invalid);
    }
}
