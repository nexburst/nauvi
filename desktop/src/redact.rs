//! Masks secret-looking text before it is written to the app log (#208).
//!
//! The log is meant to hold only what the app says about itself, and the
//! messages it writes are built from `chain_text`/`error_text`, which leave
//! out env values and plugin output (#243). This is the second line of
//! defence for text the app does not control (a panic message, a UI error,
//! a library's warning): bearer and basic credentials, JWTs, PEM blocks, a
//! URL's user and password, and the values of token, password, secret and
//! kubeconfig key fields. It masks too much rather than too little.

use regex::{Regex, RegexBuilder};
use std::sync::LazyLock;

/// What replaces a masked value.
pub(crate) const MASK: &str = "[redacted]";

static PEM: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"-----BEGIN [A-Z0-9 ]+-----.*?(-----END [A-Z0-9 ]+-----|\z)")
        .dot_matches_new_line(true)
        .build()
        .unwrap()
});

/// `Authorization: Bearer x`, `Basic x`.
static SCHEME: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}")
        .case_insensitive(true)
        .build()
        .unwrap()
});

/// The user and password in a URL (`https://user:pass@host`).
static USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@").unwrap());

/// A JSON Web Token (ServiceAccount and OIDC tokens are ones).
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*").unwrap()
});

/// `token=x`, `password: x`, `"client-key-data": "x"`, `--token x`: a key
/// that names a credential, the separator (with any quotes) and the value
/// up to a delimiter.
static FIELD: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(
        r#"(?P<key>[A-Za-z0-9_.-]*(token|passw(or)?d|secret|client-key-data|client-certificate-data|certificate-authority-data|authorization|api-?key|credential)[A-Za-z0-9_.-]*)(?P<sep>"?\s*[:=]\s*"?|\s+)(?P<value>[^\s",;&}\]'`]+)"#,
    )
    .case_insensitive(true)
    .build()
    .unwrap()
});

/// Values that are not secrets: a mask already there, and the scheme of an
/// `Authorization` value (its credentials are masked by `SCHEME`).
fn kept_value(value: &str) -> bool {
    value.starts_with("[redacted")
        || value.eq_ignore_ascii_case("bearer")
        || value.eq_ignore_ascii_case("basic")
}

/// `text` with secret-looking parts replaced by [`MASK`].
pub(crate) fn redact(text: &str) -> String {
    let text = PEM.replace_all(text, MASK);
    let text = JWT.replace_all(&text, MASK);
    let text = USERINFO.replace_all(&text, format!("${{1}}{MASK}@"));
    let text = SCHEME.replace_all(&text, format!("${{1}}${{2}}{MASK}"));
    let source: &str = &text;
    let text = FIELD.replace_all(source, |c: &regex::Captures| {
        let (key, sep, value) = (&c["key"], &c["sep"], &c["value"]);
        let start = c.get(0).map_or(0, |m| m.start());
        // A Rust path (`kubeloupe::exec_credentials: ...`, a log target)
        // names a module, not a field.
        let module = source[..start].ends_with("::");
        // "key value" with only spaces between is a value only after a
        // flag (`--token x`); otherwise it is prose ("the token expired").
        let assigned = sep.contains([':', '=']) || key.starts_with("--");
        if module || !assigned || kept_value(value) {
            c[0].to_string()
        } else {
            format!("{key}{sep}{MASK}")
        }
    });
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credentials() {
        let cases = [
            (
                "Authorization: Bearer abc.def-123",
                "Authorization: Bearer [redacted]",
            ),
            ("basic dXNlcjpwYXNz", "basic [redacted]"),
            ("token=s3cr3t-value", "token=[redacted]"),
            ("password: hunter2", "password: [redacted]"),
            (
                r#"{"client-key-data":"LS0tLS1CRUdJTg=="}"#,
                r#"{"client-key-data":"[redacted]"}"#,
            ),
            ("--token abcdef", "--token [redacted]"),
            (
                "proxy https://me:pw@proxy.example:3128/x",
                "proxy https://[redacted]@proxy.example:3128/x",
            ),
            (
                "AWS_SECRET_ACCESS_KEY=xyz",
                "AWS_SECRET_ACCESS_KEY=[redacted]",
            ),
            ("access_token: ya29.abc", "access_token: [redacted]"),
            ("api-key=k1", "api-key=[redacted]"),
        ];
        for (input, want) in cases {
            assert_eq!(redact(input), want, "{input}");
        }
    }

    #[test]
    fn masks_jwts_and_pem() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
        assert_eq!(redact(&format!("got {jwt} back")), "got [redacted] back");
        let pem = "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabcd\n-----END RSA PRIVATE KEY-----\ndone";
        assert_eq!(redact(pem), "key:\n[redacted]\ndone");
        // Cut off before its END line: the rest goes too.
        assert_eq!(
            redact("x -----BEGIN CERTIFICATE-----\nMIIB"),
            "x [redacted]"
        );
    }

    #[test]
    fn keeps_plain_prose() {
        for text in [
            "the token expired",
            "Secret demo/db was deleted",
            "could not refresh the token for context kind",
            "window main reloaded; its session starts over",
            "kubeloupe 0.1.0 (abc1234) on Linux",
            "Secrets are listed without their values",
            "WARN kubeloupe::exec_credentials: the plugin exited",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn is_idempotent() {
        let once = redact("token=abc Bearer xyz123 password: p");
        assert_eq!(redact(&once), once);
    }
}
