//! Hides what looks like a secret in a container's command line before it
//! reaches the screen: `--token=abc` becomes `--token=••••`, `--password abc`
//! becomes `--password ••••`, `PGPASSWORD=abc` becomes `PGPASSWORD=••••`,
//! and `postgres://user:abc@db` becomes `postgres://user:••••@db`.
//!
//! A guess, not a guarantee: the YAML view still shows the spec as stored.

/// What replaces a hidden value.
pub const MASK: &str = "••••";

/// Parts of a flag or variable name that mark its value as secret.
const SENSITIVE: &[&str] = &[
    "token",
    "password",
    "passwd",
    "secret",
    "apikey",
    "api-key",
    "api_key",
    "credential",
    "private-key",
    "private_key",
    "access-key",
    "access_key",
];

fn sensitive(name: &str) -> bool {
    let n = name.trim_start_matches('-').to_ascii_lowercase();
    !n.is_empty()
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && SENSITIVE.iter().any(|s| n.contains(s))
}

/// A bare flag (`--password`) whose value is the next word.
fn sensitive_flag(word: &str) -> bool {
    word.starts_with('-') && !word.contains('=') && sensitive(word)
}

/// `argv` with secret-looking values replaced by [`MASK`], and whether
/// anything was hidden. A sensitive flag on its own masks the next element.
pub fn mask_args(argv: &[String]) -> (Vec<String>, bool) {
    let mut hidden = false;
    let mut next_is_secret = false;
    let out = argv
        .iter()
        .map(|a| {
            if next_is_secret && !a.starts_with('-') {
                next_is_secret = false;
                hidden = true;
                return MASK.to_string();
            }
            next_is_secret = sensitive_flag(a);
            let (text, h) = mask_text(a);
            hidden |= h;
            text
        })
        .collect();
    (out, hidden)
}

/// One string (an element of argv, or a whole `sh -c` script) with its
/// secret-looking values replaced.
pub fn mask_text(s: &str) -> (String, bool) {
    let mut out = String::with_capacity(s.len());
    let mut hidden = false;
    let mut next_is_secret = false;
    let mut rest = s;
    while !rest.is_empty() {
        let start = rest.len() - rest.trim_start().len();
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if rest.is_empty() {
            break;
        }
        let (word, after) = split_word(rest);
        rest = after;
        if next_is_secret && !word.starts_with('-') {
            next_is_secret = false;
            hidden = true;
            out.push_str(&keep_quotes(word));
            continue;
        }
        next_is_secret = sensitive_flag(word.trim_matches(|c| c == '"' || c == '\''));
        let (w, h) = mask_word(word);
        hidden |= h;
        out.push_str(&w);
    }
    (out, hidden)
}

/// The next word of `s` (which starts with a non-space), keeping a quoted
/// value whole: `--password='a b'` is one word.
fn split_word(s: &str) -> (&str, &str) {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => return (&s[..i], &s[i..]),
            None => {}
        }
    }
    (s, "")
}

/// A masked word that keeps its surrounding quotes: `'abc'` -> `'••••'`.
fn keep_quotes(word: &str) -> String {
    let q = word.chars().next().filter(|c| *c == '"' || *c == '\'');
    match q {
        Some(q) if word.len() > 1 && word.ends_with(q) => format!("{q}{MASK}{q}"),
        _ => MASK.to_string(),
    }
}

fn mask_word(word: &str) -> (String, bool) {
    if let Some(eq) = word.find('=') {
        let name = word[..eq].trim_start_matches(['"', '\'']);
        if sensitive(name) && eq + 1 < word.len() {
            return (
                format!("{}={}", &word[..eq], keep_quotes(&word[eq + 1..])),
                true,
            );
        }
    }
    mask_url_password(word)
}

/// `scheme://user:password@host` -> `scheme://user:••••@host`.
fn mask_url_password(word: &str) -> (String, bool) {
    let Some(scheme_end) = word.find("://") else {
        return (word.to_string(), false);
    };
    let auth_start = scheme_end + 3;
    let tail = &word[auth_start..];
    let authority_end = tail.find(['/', '?', '#']).unwrap_or(tail.len());
    let authority = &tail[..authority_end];
    let Some(at) = authority.rfind('@') else {
        return (word.to_string(), false);
    };
    let Some(colon) = authority[..at].find(':') else {
        return (word.to_string(), false);
    };
    if colon + 1 == at {
        return (word.to_string(), false);
    }
    let pw_start = auth_start + colon + 1;
    let pw_end = auth_start + at;
    (
        format!("{}{MASK}{}", &word[..pw_start], &word[pw_end..]),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_with_secret_names_lose_their_values() {
        let (out, hidden) = mask_args(&v(&[
            "/app",
            "--token=abc123",
            "--client-secret=s3",
            "--password",
            "hunter2",
            "--port=8080",
            "--api-key='a b'",
        ]));
        assert_eq!(
            out,
            v(&[
                "/app",
                "--token=••••",
                "--client-secret=••••",
                "--password",
                "••••",
                "--port=8080",
                "--api-key='••••'",
            ])
        );
        assert!(hidden);
    }

    #[test]
    fn plain_commands_are_unchanged() {
        let argv = v(&[
            "sh",
            "-c",
            "while true; do echo \"$(date -u +%FT%TZ) app: serving\"; sleep 1; done",
        ]);
        assert_eq!(mask_args(&argv), (argv.clone(), false));
        // A flag that only names a file of tokens loses its path too: one
        // path too many beats one token too few.
        let (out, _) = mask_args(&v(&[
            "--token-auth-file=/etc/tokens.csv",
            "--authorization-mode=Node",
        ]));
        assert_eq!(
            out,
            v(&["--token-auth-file=••••", "--authorization-mode=Node"])
        );
    }

    #[test]
    fn scripts_variables_and_urls_are_masked_inside_one_string() {
        let (out, hidden) = mask_text(
            "PGPASSWORD=s3cr3t psql postgres://app:pw@db:5432/app --password \"x y\" && run --token=t",
        );
        assert_eq!(
            out,
            "PGPASSWORD=•••• psql postgres://app:••••@db:5432/app --password \"••••\" && run --token=••••"
        );
        assert!(hidden);
        assert!(!out.contains("s3cr3t") && !out.contains(":pw@") && !out.contains("x y"));
        // A URL without a password, and an empty value, stay as they are.
        assert_eq!(
            mask_text("curl https://user@host/x --token="),
            ("curl https://user@host/x --token=".to_string(), false)
        );
    }
}
