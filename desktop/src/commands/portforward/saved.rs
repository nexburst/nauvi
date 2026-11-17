//! Saved port-forwards (#217): kept per context in the settings, so they
//! come back after a restart. Pure functions on [`Settings`]; the commands
//! in `mod.rs` run them through the settings store.

use crate::settings::{SavedForward, Settings};
use nauvi::RemotePort;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A new id, unique across restarts: the time plus a counter.
fn new_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("fwd-{}-{}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// The local port field: `""` is automatic (`None`), `"0"` any free port.
pub(crate) fn parse_local(text: &str) -> Result<Option<u16>, String> {
    let s = text.trim();
    if s.is_empty() {
        return Ok(None);
    }
    s.parse::<u16>().map(Some).map_err(|_| {
        format!("the local port must be a number between 0 and 65535, or empty, not \"{s}\"")
    })
}

/// The local port as stored: what [`parse_local`] reads back.
pub(crate) fn local_text(local: Option<u16>) -> String {
    local.map(|n| n.to_string()).unwrap_or_default()
}

/// Check `f` and bring it to its stored form (trimmed ports).
pub(crate) fn normalize(mut f: SavedForward) -> Result<SavedForward, String> {
    if f.target.name.trim().is_empty() || f.target.namespace.trim().is_empty() {
        return Err("a port-forward needs a namespace and a name to forward to".into());
    }
    RemotePort::parse(&f.remote).map_err(|e| e.to_string())?;
    f.remote = f.remote.trim().to_string();
    f.local_port = local_text(parse_local(&f.local_port)?);
    Ok(f)
}

/// The saved forwards of context `ctx`, in the order they were added.
pub(crate) fn list(s: &Settings, ctx: &str) -> Vec<SavedForward> {
    s.forwards.get(ctx).cloned().unwrap_or_default()
}

pub(crate) fn find(s: &Settings, ctx: &str, id: &str) -> Option<SavedForward> {
    s.forwards.get(ctx)?.iter().find(|f| f.id == id).cloned()
}

/// Add `f` (id `""`: a new one, which gets an id) or replace the saved one
/// with its id. Returns what was stored.
pub(crate) fn upsert(s: &mut Settings, ctx: &str, f: SavedForward) -> Result<SavedForward, String> {
    let mut f = normalize(f)?;
    let saved = s.forwards.entry(ctx.to_string()).or_default();
    if f.id.is_empty() {
        f.id = new_id();
        saved.push(f.clone());
        return Ok(f);
    }
    match saved.iter_mut().find(|g| g.id == f.id) {
        Some(slot) => {
            *slot = f.clone();
            Ok(f)
        }
        None => Err("this port-forward was deleted in the meantime".into()),
    }
}

/// Remove the saved forward `id`. Removing one that is gone is not an error.
pub(crate) fn remove(s: &mut Settings, ctx: &str, id: &str) {
    if let Some(saved) = s.forwards.get_mut(ctx) {
        saved.retain(|f| f.id != id);
        if saved.is_empty() {
            s.forwards.remove(ctx);
        }
    }
}

/// The saved forward a quick start (from a pod's or Service's details)
/// matches: same target, remote port and local port.
pub(crate) fn matching<'a>(
    saved: &'a [SavedForward],
    target: &nauvi::ForwardTarget,
    remote: &str,
    local: Option<u16>,
) -> Option<&'a SavedForward> {
    let local = local_text(local);
    saved
        .iter()
        .find(|f| &f.target == target && f.remote == remote && f.local_port == local)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nauvi::{ForwardKind, ForwardTarget};

    fn fwd(name: &str, remote: &str, local: &str) -> SavedForward {
        SavedForward {
            id: String::new(),
            target: ForwardTarget {
                kind: ForwardKind::Service,
                namespace: "demo".into(),
                name: name.into(),
            },
            remote: remote.into(),
            local_port: local.into(),
            https: false,
            open_in_browser: false,
            auto_start: false,
        }
    }

    #[test]
    fn saved_forwards_are_per_context_and_keep_their_order() {
        let mut s = Settings::default();
        let a = upsert(&mut s, "kind", fwd("web", "80", "")).unwrap();
        let b = upsert(&mut s, "kind", fwd("api", "http", " 8080 ")).unwrap();
        upsert(&mut s, "prod", fwd("web", "80", "")).unwrap();
        assert!(!a.id.is_empty() && a.id != b.id);
        assert_eq!(b.local_port, "8080");
        let kind = list(&s, "kind");
        assert_eq!(
            kind.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            [a.id.as_str(), b.id.as_str()]
        );
        assert_eq!(list(&s, "prod").len(), 1);
        assert!(list(&s, "other").is_empty());
    }

    #[test]
    fn edits_replace_and_deletes_remove() {
        let mut s = Settings::default();
        let a = upsert(&mut s, "kind", fwd("web", "80", "")).unwrap();
        let edited = SavedForward {
            https: true,
            local_port: "8443".into(),
            ..a.clone()
        };
        upsert(&mut s, "kind", edited).unwrap();
        let f = find(&s, "kind", &a.id).unwrap();
        assert!(f.https);
        assert_eq!(f.local_port, "8443");
        remove(&mut s, "kind", &a.id);
        assert!(find(&s, "kind", &a.id).is_none());
        assert!(!s.forwards.contains_key("kind"));
        // Gone already: not an error; editing it is.
        remove(&mut s, "kind", &a.id);
        assert_eq!(
            upsert(&mut s, "kind", a).unwrap_err(),
            "this port-forward was deleted in the meantime"
        );
    }

    #[test]
    fn bad_ports_are_refused() {
        let mut s = Settings::default();
        assert!(upsert(&mut s, "kind", fwd("web", "", "")).is_err());
        assert!(upsert(&mut s, "kind", fwd("web", "99999", "")).is_err());
        assert_eq!(
            upsert(&mut s, "kind", fwd("web", "80", "x")).unwrap_err(),
            "the local port must be a number between 0 and 65535, or empty, not \"x\""
        );
        assert!(upsert(&mut s, "kind", fwd("", "80", "")).is_err());
        assert!(s.forwards.is_empty());
    }

    #[test]
    fn quick_starts_match_on_target_and_ports() {
        let mut s = Settings::default();
        upsert(&mut s, "kind", fwd("web", "80", "")).unwrap();
        upsert(&mut s, "kind", fwd("web", "80", "9000")).unwrap();
        let saved = list(&s, "kind");
        let t = saved[0].target.clone();
        assert_eq!(matching(&saved, &t, "80", None).unwrap().local_port, "");
        assert_eq!(
            matching(&saved, &t, "80", Some(9000)).unwrap().local_port,
            "9000"
        );
        assert!(matching(&saved, &t, "81", None).is_none());
    }

    #[test]
    fn saved_forwards_survive_a_settings_round_trip() {
        let mut s = Settings::default();
        let mut f = fwd("web", "80", "8080");
        f.https = true;
        f.auto_start = true;
        upsert(&mut s, "kind", f).unwrap();
        let text = serde_json::to_string(&s).unwrap();
        assert_eq!(crate::settings::parse(&text).unwrap(), s);
        // Older files have none.
        assert!(crate::settings::parse(r#"{"version":1}"#)
            .unwrap()
            .forwards
            .is_empty());
    }
}
