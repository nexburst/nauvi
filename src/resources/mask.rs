//! Hides what looks like a secret in a container's command line before it
//! reaches the screen:
//!
//! - `--token=abc`, `PGPASSWORD=abc`, `--pass abc`: a flag or variable whose
//!   name says secret loses its value (`--token=••••`);
//! - `-p abc`, `-pabc`: the short password flag of mysql and friends (not
//!   when the value is a number or a path: `ssh -p 22`, `mkdir -p /data`);
//! - `-u user:abc`, `--user user:abc`: the part after the colon;
//! - `Authorization: Bearer abc`: the word after `Bearer`;
//! - `postgres://user:abc@db`: the URL's password;
//! - `AKIA…`/`ASIA…`: AWS access key ids, wherever they are.
//!
//! Flags that name where a secret lives (`--tls-private-key-file`,
//! `--token-path`, `--secret-name`, `--secrets-dir`) keep their value.
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

/// Whole name segments (split on `-`, `_`, `.`) that mark a secret.
const SENSITIVE_SEGMENTS: &[&str] = &["pass", "pwd", "pw"];

/// Last segments of a name whose value says where a secret is, not what.
const LOCATION_SEGMENTS: &[&str] = &["file", "dir", "path", "name"];

/// Single-dash options that start with `p` and are not `-p<password>`
/// (`find -print`, Go's `-port`).
const P_OPTIONS: &[&str] = &[
    "parents", "path", "perm", "pid", "pidfile", "pipe", "port", "pprof", "preserve", "print",
    "print0", "printf", "profile", "prune", "pthread",
];

fn segments(n: &str) -> impl Iterator<Item = &str> {
    n.split(['-', '_', '.']).filter(|s| !s.is_empty())
}

fn sensitive(name: &str) -> bool {
    let n = name.trim_start_matches('-').to_ascii_lowercase();
    if n.is_empty()
        || !n
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return false;
    }
    if segments(&n)
        .last()
        .is_some_and(|s| LOCATION_SEGMENTS.contains(&s))
    {
        return false;
    }
    SENSITIVE.iter().any(|s| n.contains(s)) || segments(&n).any(|s| SENSITIVE_SEGMENTS.contains(&s))
}

/// What the next word is, after the current one.
#[derive(Clone, Copy, PartialEq)]
enum Next {
    Plain,
    /// After `--password`, `Bearer`: the whole word.
    Secret,
    /// After `-p`: the whole word, unless a number or a path.
    Short,
    /// After `-u`, `--user`: what follows the first colon.
    UserPass,
}

fn next_after(word: &str) -> Next {
    if word.eq_ignore_ascii_case("bearer") {
        return Next::Secret;
    }
    if !word.starts_with('-') || word.contains('=') {
        return Next::Plain;
    }
    match word {
        "-p" => Next::Short,
        "-u" | "--user" => Next::UserPass,
        w if sensitive(w) => Next::Secret,
        _ => Next::Plain,
    }
}

fn is_number_or_path(v: &str) -> bool {
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        || v.starts_with('/')
        || v.starts_with('.')
        || v.starts_with('~')
        || v.starts_with('$')
}

/// `user:abc` -> `user:••••`; no colon, nothing hidden.
fn mask_after_colon(v: &str) -> Option<String> {
    let colon = v.find(':')?;
    let end = v.len() - v.ends_with(['"', '\'']) as usize;
    (colon + 1 < end).then(|| format!("{}{MASK}{}", &v[..=colon], &v[end..]))
}

struct Masker {
    next: Next,
    hidden: bool,
}

impl Masker {
    /// `word` as the value `next` expects, or None to treat it as a word.
    fn value(&mut self, word: &str) -> Option<String> {
        let next = std::mem::replace(&mut self.next, Next::Plain);
        let bare = word.trim_matches(['"', '\'']);
        if next == Next::Plain || bare.starts_with('-') {
            return None;
        }
        let out = match next {
            Next::Secret => Some(keep_quotes(word)),
            Next::Short if !is_number_or_path(bare) => Some(keep_quotes(word)),
            Next::UserPass => mask_after_colon(word),
            _ => None,
        };
        self.hidden |= out.is_some();
        // A value read is a value, never a flag that names the next one.
        out.or_else(|| Some(word.to_string()))
    }

    fn word(&mut self, word: &str) -> String {
        if let Some(v) = self.value(word) {
            return v;
        }
        self.next = next_after(word.trim_matches(['"', '\'']));
        let (w, h) = mask_word(word);
        self.hidden |= h;
        w
    }

    fn text(&mut self, s: &str) -> String {
        let mut out = String::with_capacity(s.len());
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
            out.push_str(&self.word(word));
        }
        out
    }
}

/// `argv` with secret-looking values replaced by [`MASK`], and whether
/// anything was hidden. A sensitive flag on its own masks the next element
/// as a whole, spaces and all.
pub fn mask_args(argv: &[String]) -> (Vec<String>, bool) {
    let mut m = Masker {
        next: Next::Plain,
        hidden: false,
    };
    let out = argv
        .iter()
        .map(|a| m.value(a).unwrap_or_else(|| m.text(a)))
        .collect();
    (out, m.hidden)
}

/// One string (a whole `sh -c` script) with its
/// secret-looking values replaced.
#[cfg(test)]
fn mask_text(s: &str) -> (String, bool) {
    let mut m = Masker {
        next: Next::Plain,
        hidden: false,
    };
    let out = m.text(s);
    (out, m.hidden)
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

/// One word on its own: `name=value`, `-pvalue`, then what may hide inside
/// any word (a quoted `Bearer` header, a URL password, an AWS key id).
fn mask_word(word: &str) -> (String, bool) {
    let mut hidden = false;
    let mut w = word.to_string();
    if let Some(eq) = w.find('=') {
        let name = w[..eq].trim_start_matches(['"', '\'']);
        let value = &w[eq + 1..];
        if sensitive(name) && !value.is_empty() {
            w = format!("{}={}", &w[..eq], keep_quotes(value));
            hidden = true;
        } else if name == "--user" {
            if let Some(v) = mask_after_colon(value) {
                w = format!("{}={v}", &w[..eq]);
                hidden = true;
            }
        }
    } else if let Some(v) = w.strip_prefix("-p") {
        if !v.is_empty()
            && !v.starts_with('-')
            && !is_number_or_path(v)
            && !P_OPTIONS.contains(&&w[1..])
        {
            w = format!("-p{MASK}");
            hidden = true;
        }
    }
    for f in [mask_bearer, mask_url_password, mask_aws_keys] {
        if let Some(m) = f(&w) {
            w = m;
            hidden = true;
        }
    }
    (w, hidden)
}

/// `"Authorization: Bearer abc"` -> `"Authorization: Bearer ••••"`.
fn mask_bearer(word: &str) -> Option<String> {
    let at = word.to_ascii_lowercase().find("bearer ")? + "bearer ".len();
    let rest = &word[at..];
    let start = at + (rest.len() - rest.trim_start().len());
    let end = word[start..]
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .map_or(word.len(), |i| start + i);
    (end > start).then(|| format!("{}{MASK}{}", &word[..start], &word[end..]))
}

/// `scheme://user:password@host` -> `scheme://user:••••@host`.
fn mask_url_password(word: &str) -> Option<String> {
    let auth_start = word.find("://")? + 3;
    let tail = &word[auth_start..];
    let authority = &tail[..tail.find(['/', '?', '#']).unwrap_or(tail.len())];
    let at = authority.rfind('@')?;
    let colon = authority[..at].find(':')?;
    (colon + 1 < at).then(|| {
        format!(
            "{}{MASK}{}",
            &word[..auth_start + colon + 1],
            &word[auth_start + at..]
        )
    })
}

/// AWS access key ids: `AKIA` or `ASIA` and 16 upper-case letters or digits.
fn mask_aws_keys(word: &str) -> Option<String> {
    let b = word.as_bytes();
    let key_at = |i: usize| {
        b.len() >= i + 20
            && (&b[i..i + 4] == b"AKIA" || &b[i..i + 4] == b"ASIA")
            && b[i + 4..i + 20]
                .iter()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && b.get(i + 20).is_none_or(|c| !c.is_ascii_alphanumeric())
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric())
    };
    let mut out = String::with_capacity(word.len());
    let mut found = false;
    let mut i = 0;
    while i < b.len() {
        if key_at(i) {
            out.push_str(MASK);
            i += 20;
            found = true;
        } else {
            let c = word[i..].chars().next()?;
            out.push(c);
            i += c.len_utf8();
        }
    }
    found.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn args(a: &[&str]) -> Vec<String> {
        mask_args(&v(a)).0
    }

    fn text(s: &str) -> String {
        mask_text(s).0
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
        // A bare flag's value is hidden whole, spaces and all.
        assert_eq!(args(&["--password", "a b"]), v(&["--password", "••••"]));
    }

    #[test]
    fn pass_and_pwd_flags() {
        assert_eq!(
            args(&["--pass", "p1", "--pwd=p2", "--db-pw", "p3"]),
            v(&["--pass", "••••", "--pwd=••••", "--db-pw", "••••"])
        );
        assert_eq!(text("run --pass p1 --pwd p2"), "run --pass •••• --pwd ••••");
        // Only whole segments: these are not passwords.
        assert_eq!(
            args(&["--passthrough=yes", "--bypass-cache=true", "--pwdx=1"]),
            v(&["--passthrough=yes", "--bypass-cache=true", "--pwdx=1"])
        );
    }

    #[test]
    fn short_password_flag_attached_or_separate() {
        assert_eq!(args(&["mysql", "-p", "s3"]), v(&["mysql", "-p", "••••"]));
        assert_eq!(args(&["mysql", "-ps3cr3t"]), v(&["mysql", "-p••••"]));
        assert_eq!(text("mysql -u root -ps3cr3t db"), "mysql -u root -p•••• db");
        assert_eq!(text("mysql -p s3cr3t db"), "mysql -p •••• db");
        // Ports and paths after -p stay.
        assert_eq!(
            text("mkdir -p /data && ssh -p 22 host && nc -p8080"),
            "mkdir -p /data && ssh -p 22 host && nc -p8080"
        );
        assert_eq!(
            text("find . -print -prune -port 9"),
            "find . -print -prune -port 9"
        );
    }

    #[test]
    fn user_and_password_pairs() {
        assert_eq!(
            args(&["curl", "-u", "admin:hunter2", "http://x"]),
            v(&["curl", "-u", "admin:••••", "http://x"])
        );
        assert_eq!(
            text("curl --user admin:hunter2 --user=bob:pw x"),
            "curl --user admin:•••• --user=bob:•••• x"
        );
        // A user without a password shows.
        assert_eq!(text("curl -u admin x"), "curl -u admin x");
    }

    #[test]
    fn bearer_tokens() {
        assert_eq!(
            args(&["curl", "-H", "Authorization: Bearer xyz.abc"]),
            v(&["curl", "-H", "Authorization: Bearer ••••"])
        );
        assert_eq!(
            text("curl -H \"Authorization: Bearer xyz\" http://x"),
            "curl -H \"Authorization: Bearer ••••\" http://x"
        );
        assert_eq!(
            text("curl -H 'authorization: bearer xyz'"),
            "curl -H 'authorization: bearer ••••'"
        );
    }

    #[test]
    fn aws_access_key_ids() {
        assert_eq!(
            text("aws --key AKIAIOSFODNN7EXAMPLE and x=ASIAABCDEFGHIJKLMNOP"),
            "aws --key •••• and x=••••"
        );
        // Not 16 characters after the prefix, or part of a longer word.
        assert_eq!(
            text("AKIASHORT XAKIAIOSFODNN7EXAMPLE"),
            "AKIASHORT XAKIAIOSFODNN7EXAMPLE"
        );
    }

    #[test]
    fn flags_that_name_a_location_keep_their_value() {
        assert_eq!(
            args(&[
                "--tls-private-key-file=/etc/tls/key.pem",
                "--token-auth-file=/etc/tokens.csv",
                "--secrets-dir",
                "/var/secrets",
                "--token-path=/var/run/token",
                "--secret-name=db-creds",
                "--authorization-mode=Node",
            ]),
            v(&[
                "--tls-private-key-file=/etc/tls/key.pem",
                "--token-auth-file=/etc/tokens.csv",
                "--secrets-dir",
                "/var/secrets",
                "--token-path=/var/run/token",
                "--secret-name=db-creds",
                "--authorization-mode=Node",
            ])
        );
    }

    #[test]
    fn plain_commands_are_unchanged() {
        let argv = v(&[
            "sh",
            "-c",
            "while true; do echo \"$(date -u +%FT%TZ) app: serving\"; sleep 1; done",
        ]);
        assert_eq!(mask_args(&argv), (argv.clone(), false));
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
        // A URL without a password, and an empty value, stay as they are.
        assert_eq!(
            mask_text("curl https://user@host/x --token="),
            ("curl https://user@host/x --token=".to_string(), false)
        );
    }
}
