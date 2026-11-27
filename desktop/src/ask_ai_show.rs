//! `nauvi show` (#548): an Ask AI session opens a view in its own window.
//!
//! Off by default ("Let Ask AI open views", Settings, AI). With it on, an
//! Ask AI session gets a grant: a random token (32 bytes from the OS,
//! hex), held here in memory only, with the window and context of the
//! session and its terminal. The token goes into the CLI's environment
//! (`NAUVI_ASK_AI_SESSION`) with the app's program (`NAUVI_APP`); nothing
//! writes it to a file or the log. The grant goes when the terminal's
//! process ends (the tab closed, the window closed, the context turned
//! read-only, the app quit): the token then opens nothing.
//!
//! `nauvi show` starts the app's program as `<app> --ask-ai-show <token>
//! <request>`, which the single-instance check hands over to the running
//! app (`single_instance.rs`; no new listener or port) and exits. The
//! request is a `nauvi://` link (or a kind's table, `nauvi::links::
//! parse_show`), checked as any link. Then:
//!
//! - an unknown token: nothing happens (logged without the token);
//! - the setting turned off since, a request for another context, a
//!   malformed request, or a second one within [`MIN_GAP`]: dropped, with
//!   a line in that session's terminal saying so;
//! - else the session's window is told to show it (`LinkRequest::AskAi`),
//!   without taking the focus. The window opens the detail panel or the
//!   kind's table, which only read, says "Opened by Ask AI", and records it
//!   as a normal history entry, so Back returns. It runs no action and
//!   opens no dialog.

use crate::commands::term_out::{send_data, TermOut};
use crate::links::{deliver_quiet, LinkRequest};
use crate::settings::SettingsStore;
use nauvi::links::{parse_show, SHOW_FLAG};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// At most one view per session in this time; more are dropped.
pub(crate) const MIN_GAP: Duration = Duration::from_secs(3);
/// Token bytes (64 hex characters).
const TOKEN_BYTES: usize = 32;

/// What a token lets its session do.
struct Grant {
    /// The window the session's terminal is in.
    label: String,
    /// The catalog id of the session's context.
    context: String,
    /// The session's terminal, for the lines saying why nothing opened.
    out: TermOut,
    /// When it last opened a view.
    last: Option<Instant>,
}

/// The live grants, by token.
static GRANTS: LazyLock<Mutex<HashMap<String, Grant>>> = LazyLock::new(Default::default);

/// A live grant; dropping it revokes its token.
pub(crate) struct ShowGrant {
    token: String,
}

impl ShowGrant {
    /// A new token for the Ask AI session in window `label` on context
    /// `context`, whose terminal is `out`.
    pub(crate) fn new(label: &str, context: &str, out: TermOut) -> Result<Self, String> {
        let mut bytes = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|e| format!("cannot make a session token: {e}"))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        GRANTS.lock().unwrap().insert(
            token.clone(),
            Grant {
                label: label.to_string(),
                context: context.to_string(),
                out,
                last: None,
            },
        );
        Ok(Self { token })
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for ShowGrant {
    fn drop(&mut self) {
        GRANTS.lock().unwrap().remove(&self.token);
    }
}

/// `(token, request)` if `args` (a launch's, the program first) are a
/// `nauvi show` hand-over. Any launch whose first argument is the flag is
/// one, well-formed or not, and never also opens a link.
pub(crate) fn request_in(args: &[String]) -> Option<(&str, &str)> {
    if args.get(1).map(String::as_str) != Some(SHOW_FLAG) {
        return None;
    }
    match args {
        [_, _, token, request] => Some((token, request)),
        _ => Some(("", "")),
    }
}

/// Whether this process was started as a `nauvi show` hand-over: when it
/// gets this far, no app was running to take it.
pub(crate) fn launched_as_request() -> bool {
    std::env::args().nth(1).as_deref() == Some(SHOW_FLAG)
}

/// What happened to a request.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// Unknown token: nothing.
    Ignored,
    /// Dropped; this line goes to the session's terminal.
    Dropped(&'static str),
    /// Show this in window `label`.
    Show(String, LinkRequest),
}

/// The decision, apart from the app: `enabled` is the setting now.
fn decide(token: &str, request: &str, enabled: bool, now: Instant) -> (Outcome, Option<TermOut>) {
    let mut grants = GRANTS.lock().unwrap();
    let Some(grant) = grants
        .get_mut(token)
        .filter(|_| token.len() == TOKEN_BYTES * 2)
    else {
        return (Outcome::Ignored, None);
    };
    let out = Some(grant.out.clone());
    if !enabled {
        return (
            Outcome::Dropped(
                "nauvi show is off: turn on Settings, AI, \"Let Ask AI open views\". Nothing was opened.",
            ),
            out,
        );
    }
    let Ok(link) = parse_show(request) else {
        return (
            Outcome::Dropped("nauvi show sent a request nauvi can't read. Nothing was opened."),
            out,
        );
    };
    if link.context != grant.context {
        return (
            Outcome::Dropped(
                "nauvi show asked for another context than this terminal's. Nothing was opened.",
            ),
            out,
        );
    }
    if grant.last.is_some_and(|t| now.duration_since(t) < MIN_GAP) {
        return (
            Outcome::Dropped(
                "nauvi show was asked again within 3 seconds: this view was not opened.",
            ),
            out,
        );
    }
    grant.last = Some(now);
    (
        Outcome::Show(grant.label.clone(), LinkRequest::AskAi { link }),
        out,
    )
}

/// Handle a hand-over from `nauvi show`.
pub(crate) fn handle(app: &AppHandle, token: &str, request: &str) {
    let enabled = app
        .try_state::<Arc<SettingsStore>>()
        .is_some_and(|s| s.get().ask_ai_open_views);
    match decide(token, request, enabled, Instant::now()) {
        (Outcome::Ignored, _) => {
            tracing::warn!("nauvi show without a live Ask AI session token: ignored");
        }
        (Outcome::Dropped(line), out) => {
            tracing::info!("nauvi show: {line}");
            if let Some(out) = out {
                send_data(&out, format!("\r\n\x1b[90m{line}\x1b[0m\r\n").into_bytes());
            }
        }
        (Outcome::Show(label, request), _) => {
            tracing::info!("nauvi show: opening a view in its Ask AI window");
            deliver_quiet(app, &label, request);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(context: &str) -> ShowGrant {
        ShowGrant::new("cluster-2", context, TermOut::detached()).unwrap()
    }

    const POD: &str = "nauvi://kind/core/v1/Pod/demo/web";

    #[test]
    fn a_token_is_random_and_goes_with_its_grant() {
        let a = grant("kind");
        let b = grant("kind");
        assert_eq!(a.token().len(), 64);
        assert!(a.token().chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a.token(), b.token());
        let token = a.token().to_string();
        drop(a);
        let (outcome, _) = decide(&token, POD, true, Instant::now());
        assert_eq!(outcome, Outcome::Ignored);
    }

    #[test]
    fn only_a_live_token_for_its_own_context_shows_a_view() {
        let g = grant("kind");
        let now = Instant::now();
        // No token, a wrong one, a prefix of the right one.
        for t in ["", "x", &g.token()[..32], &"0".repeat(64)] {
            assert_eq!(decide(t, POD, true, now).0, Outcome::Ignored, "{t}");
        }
        assert!(matches!(
            decide(g.token(), POD, false, now).0,
            Outcome::Dropped(l) if l.contains("Let Ask AI open views")
        ));
        assert!(matches!(
            decide(g.token(), "nauvi://other/core/v1/Pod/demo/web", true, now).0,
            Outcome::Dropped(l) if l.contains("another context")
        ));
        assert!(matches!(
            decide(
                g.token(),
                "nauvi://kind/core/v1/Pod/demo/web?exec=sh",
                true,
                now
            )
            .0,
            Outcome::Dropped(_)
        ));
        match decide(g.token(), POD, true, now).0 {
            Outcome::Show(label, LinkRequest::AskAi { link }) => {
                assert_eq!(label, "cluster-2");
                assert_eq!(
                    (link.namespace.as_str(), link.name.as_str()),
                    ("demo", "web")
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn one_view_per_three_seconds() {
        let g = grant("kind");
        let t0 = Instant::now();
        assert!(matches!(
            decide(g.token(), POD, true, t0).0,
            Outcome::Show(..)
        ));
        let soon = t0 + Duration::from_millis(2900);
        assert!(matches!(
            decide(g.token(), POD, true, soon).0,
            Outcome::Dropped(l) if l.contains("3 seconds")
        ));
        // A dropped request does not restart the wait.
        let later = t0 + MIN_GAP;
        assert!(matches!(
            decide(g.token(), POD, true, later).0,
            Outcome::Show(..)
        ));
        // A kind's table counts the same.
        let table = "nauvi://kind/core/v1/Pod/demo/_";
        assert!(matches!(
            decide(g.token(), table, true, later).0,
            Outcome::Dropped(_)
        ));
    }

    #[test]
    fn reads_a_hand_over_and_nothing_else() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            request_in(&a(&["nauvi", SHOW_FLAG, "tok", POD])),
            Some(("tok", POD))
        );
        // Malformed hand-overs are still hand-overs: never a plain link.
        assert_eq!(request_in(&a(&["nauvi", SHOW_FLAG, POD])), Some(("", "")));
        assert_eq!(request_in(&a(&["nauvi", POD])), None);
        assert_eq!(request_in(&a(&["nauvi", "x", SHOW_FLAG, "t", POD])), None);
    }
}
