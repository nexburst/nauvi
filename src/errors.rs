//! Plain text for errors shown to people: the CLI's error line, the app's
//! banners and inline messages.
//!
//! kube-rs's errors print a lot that is meant for developers: an API error
//! is `ApiError: <message>: <reason> (ErrorResponse { .. })`, and the
//! watcher and the kubeconfig loader wrap it again and repeat it. These
//! functions keep each part of an error chain once and use the API server's
//! own message for an API error.

use kube::core::ErrorResponse;
use std::error::Error as StdError;
use std::path::Path;

/// The API server's error response behind `err`, if any.
pub fn api_response<'a>(err: &'a (dyn StdError + 'static)) -> Option<&'a ErrorResponse> {
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(kube::Error::Api(r)) = e.downcast_ref::<kube::Error>() {
            return Some(r);
        }
        if let Some(r) = e.downcast_ref::<ErrorResponse>() {
            return Some(r);
        }
        cur = e.source();
    }
    None
}

/// The text of an API error response: its message, or its reason and code
/// when it has none.
pub fn response_text(r: &ErrorResponse) -> String {
    if r.message.is_empty() {
        format!("{} ({})", r.reason, r.code)
    } else {
        r.message.clone()
    }
}

/// The API server's own message if `err` is an API error, otherwise
/// [`chain_text`]. For messages that already say what failed, like "You
/// can't list Pods in namespace demo."
pub fn api_message(err: &(dyn StdError + 'static)) -> String {
    match api_response(err) {
        Some(r) => response_text(r),
        None => chain_text(err),
    }
}

/// One line for an error and its sources, joined with ": ".
///
/// Each part appears once: an error whose text includes its source's text
/// keeps only its own part, and a part an earlier one already contains is
/// dropped. An API error is replaced by the API server's message and ends
/// the chain (its sources only repeat it).
pub fn chain_text(err: &(dyn StdError + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        let api = match e.downcast_ref::<kube::Error>() {
            Some(kube::Error::Api(r)) => Some(r),
            _ => e.downcast_ref::<ErrorResponse>(),
        };
        let exec_run = e
            .downcast_ref::<kube::client::AuthError>()
            .and_then(crate::auth::exec_run_text);
        let text = match (api, exec_run) {
            (Some(r), _) => response_text(r),
            (None, Some(t)) => t,
            (None, None) => own_text(e),
        };
        if !text.is_empty() && !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        if api.is_some() {
            break;
        }
        cur = e.source();
    }
    parts.join(": ")
}

/// [`chain_text`] for an `anyhow` error (its context chain).
pub fn error_text(err: &anyhow::Error) -> String {
    chain_text(err.as_ref())
}

/// Text for a kubeconfig at `path` (`None`: the default ones) that could not
/// be loaded. kube prints the file's path with `{:?}` (quoted, and with
/// doubled backslashes on Windows); this shows it as it is.
pub fn kubeconfig_error_text(e: &kube::config::KubeconfigError, path: Option<&Path>) -> String {
    match (e, path) {
        (kube::config::KubeconfigError::ReadConfig(io, read), _) => {
            format!("Cannot read the kubeconfig {}: {io}", read.display())
        }
        (_, Some(path)) => format!(
            "Cannot use the kubeconfig {}: {}",
            path.display(),
            chain_text(e)
        ),
        (_, None) => format!("Cannot use the kubeconfig: {}", chain_text(e)),
    }
}

/// How server-side apply's message starts when the object does not match
/// its schema (a field of the wrong type). The API server answers it with
/// a 500.
const TYPED_PATCH_FAILED: &str = "failed to create typed patch object";

/// Go's `%#v` dump of the offending value in a typed-patch error.
const VALUE_DUMP: &str = "&value.valueUnstructured{Value:";

/// The problems in a typed-patch error, if `message` is one: the field paths
/// and what was wrong, without the object it names (callers show that) and
/// with Go's dump of the value replaced by its kind.
///
/// `failed to create typed patch object (ns/x; /v1, Kind=ConfigMap): .data.k:
/// expected string, got &value.valueUnstructured{Value:[]interface {}{..}}`
/// becomes `.data.k: expected string, got a list.`
pub fn typed_patch_problem(message: &str) -> Option<String> {
    let (_, rest) = message.split_once(TYPED_PATCH_FAILED)?;
    let rest = rest.trim_start();
    // Drop the "(ns/name; /v1, Kind=ConfigMap):" that names the object.
    let mut rest = match rest.strip_prefix('(').and_then(|r| r.split_once("):")) {
        Some((_, after)) => after.trim_start(),
        None => rest.trim_start_matches(':').trim_start(),
    };
    let mut out = String::new();
    while let Some(i) = rest.find(VALUE_DUMP) {
        out.push_str(&rest[..i]);
        let value = &rest[i + VALUE_DUMP.len()..];
        out.push_str(if value.starts_with("[]") {
            "a list"
        } else if value.starts_with("map[") {
            "a map"
        } else if value.starts_with('"') {
            "a string"
        } else {
            "a value of another type"
        });
        rest = &value[dump_len(value)..];
    }
    out.push_str(rest);
    let out = out.trim();
    if out.is_empty() {
        return Some("the object does not match its schema.".to_string());
    }
    Some(if out.ends_with('.') {
        out.to_string()
    } else {
        format!("{out}.")
    })
}

/// The length of the Go dump at the start of `s`: up to and including the
/// `}` that closes the `valueUnstructured{` before it, skipping braces in
/// string literals.
fn dump_len(s: &str) -> usize {
    let mut depth = 1usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if in_str => escaped = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
    }
    s.len()
}

/// The part of an error's text that is its own: without its source's text
/// when it embeds it (`"failed to list: {source}"` -> `"failed to list"`).
fn own_text(e: &(dyn StdError + 'static)) -> String {
    let text = e.to_string();
    let Some(source) = e.source() else {
        return text;
    };
    // The source as it appears inside: an API error prints its debug dump.
    let inner = source.to_string();
    match text.find(&inner) {
        Some(0) => String::new(),
        Some(i) => text[..i].trim_end_matches([' ', ':', '(', ',']).to_string(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forbidden() -> ErrorResponse {
        ErrorResponse {
            status: "Failure".into(),
            message: "pods is forbidden: User \"limited\" cannot list resource \"pods\"".into(),
            reason: "Forbidden".into(),
            code: 403,
        }
    }

    #[test]
    fn the_api_message_replaces_kubes_debug_dump() {
        let err: anyhow::Error = kube::Error::Api(forbidden()).into();
        assert_eq!(
            error_text(&err),
            "pods is forbidden: User \"limited\" cannot list resource \"pods\""
        );
    }

    #[test]
    fn a_watcher_error_keeps_its_own_words_and_the_api_message_once() {
        let err = kube::runtime::watcher::Error::InitialListFailed(kube::Error::Api(forbidden()));
        let text = chain_text(&err);
        assert_eq!(
            text,
            "failed to perform initial object list: pods is forbidden: User \"limited\" cannot list resource \"pods\""
        );
        assert!(!text.contains("ErrorResponse"));
        assert_eq!(
            api_message(&err),
            "pods is forbidden: User \"limited\" cannot list resource \"pods\""
        );
        let during = kube::runtime::watcher::Error::WatchError(forbidden());
        assert_eq!(api_message(&during), forbidden().message);
    }

    #[test]
    fn context_is_kept_and_repeats_are_dropped() {
        let api: anyhow::Error = kube::Error::Api(ErrorResponse {
            status: "Failure".into(),
            message: "pods \"x\" not found".into(),
            reason: "NotFound".into(),
            code: 404,
        })
        .into();
        assert_eq!(
            error_text(&api.context("describe pod/x")),
            "describe pod/x: pods \"x\" not found"
        );
        let io = anyhow::Error::from(std::io::Error::other("no such file"))
            .context("failed to read kubeconfig: no such file")
            .context("cannot read kubeconfig /k");
        assert_eq!(
            error_text(&io),
            "cannot read kubeconfig /k: failed to read kubeconfig: no such file"
        );
    }

    #[test]
    fn an_empty_api_message_shows_reason_and_code() {
        let err: anyhow::Error = kube::Error::Api(ErrorResponse {
            status: "Failure".into(),
            message: String::new(),
            reason: "Forbidden".into(),
            code: 403,
        })
        .into();
        assert_eq!(error_text(&err), "Forbidden (403)");
    }

    #[test]
    fn a_typed_patch_error_names_the_field_and_the_kind_of_value() {
        // kind's answer to a server-side apply of `data: {k: [not, a, string]}`.
        let list = "failed to create typed patch object (tmp/qa-bad; /v1, Kind=ConfigMap): \
                    .data.k: expected string, got &value.valueUnstructured{Value:[]interface {}{\"not\", \"a\", \"string\"}}";
        assert_eq!(
            typed_patch_problem(list).as_deref(),
            Some(".data.k: expected string, got a list.")
        );
        let map = "failed to create typed patch object (tmp/d; apps/v1, Kind=Deployment): \
                   .spec.replicas: expected numeric (int or float), got \
                   &value.valueUnstructured{Value:map[string]interface {}{\"a\":\"}{\"}}";
        assert_eq!(
            typed_patch_problem(map).as_deref(),
            Some(".spec.replicas: expected numeric (int or float), got a map.")
        );
        let scalar = "failed to create typed patch object (tmp/d; apps/v1, Kind=Deployment): \
                      .spec.replicas: expected numeric (int or float), got string";
        assert_eq!(
            typed_patch_problem(scalar).as_deref(),
            Some(".spec.replicas: expected numeric (int or float), got string.")
        );
        let two = "failed to create typed patch object (x; /v1, Kind=ConfigMap): errors:\n  \
                   .data.a: expected string, got &value.valueUnstructured{Value:[]interface {}{}}\n  \
                   .data.b: expected string, got &value.valueUnstructured{Value:map[string]interface {}{}}";
        assert_eq!(
            typed_patch_problem(two).as_deref(),
            Some("errors:\n  .data.a: expected string, got a list\n  .data.b: expected string, got a map.")
        );
        assert_eq!(typed_patch_problem("etcdserver: request timed out"), None);
    }

    #[test]
    fn a_kubeconfig_path_is_shown_as_it_is() {
        let path = std::path::PathBuf::from(r"C:\Users\me\.kube\config");
        let e = kube::config::KubeconfigError::ReadConfig(
            std::io::Error::new(std::io::ErrorKind::NotFound, "not found"),
            path,
        );
        assert_eq!(
            kubeconfig_error_text(&e, None),
            r"Cannot read the kubeconfig C:\Users\me\.kube\config: not found"
        );
        let e = kube::config::KubeconfigError::CurrentContextNotSet;
        assert_eq!(
            kubeconfig_error_text(&e, Some(Path::new("/k"))),
            "Cannot use the kubeconfig /k: failed to determine current context"
        );
    }

    #[test]
    fn a_plain_error_is_its_text() {
        let err = std::io::Error::other("connection refused");
        assert_eq!(chain_text(&err), "connection refused");
    }
}
