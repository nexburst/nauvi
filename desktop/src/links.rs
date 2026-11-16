//! `kubeloupe://` links to one object (#299):
//! `kubeloupe://<context>/<group>/<version>/<kind>/<namespace>/<name>`.
//!
//! `core` stands for the core group and `_` for "no namespace" (a
//! cluster-scoped object). The context is percent-encoded, as are the other
//! parts if they ever need it.
//!
//! Links come from anywhere (a chat, a web page, a ticket), so every part is
//! checked here before anything looks at it: Kubernetes' own name rules
//! (DNS labels and subdomains) with their length caps, a printable-ASCII
//! context name, no query, fragment or extra segment, and a cap on the whole
//! link. A link only ever navigates: `route` opens the object's detail panel
//! in a window on that context, if the context is one of the user's.

mod route;

#[cfg(target_os = "macos")]
pub(crate) use route::opened;
pub(crate) use route::{open_from_args, open_launch_link, take, LinkPending, LinkRequest};

use serde::{Deserialize, Serialize};
use specta::Type;

pub(crate) const SCHEME: &str = "kubeloupe";

/// No link longer than this is read (the longest valid one is about 1.9 kB,
/// with a context of 253 characters that all need percent-encoding).
const MAX_LINK: usize = 2048;
const MAX_CONTEXT: usize = 253;
const CORE_GROUP: &str = "core";
const NO_NAMESPACE: &str = "_";

/// What a link points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) struct ObjectLink {
    /// The context's id in the catalog (its name, for the default kubeconfig).
    pub(crate) context: String,
    /// `""` for the core group.
    pub(crate) group: String,
    pub(crate) version: String,
    pub(crate) kind: String,
    /// `""` for a cluster-scoped object.
    pub(crate) namespace: String,
    pub(crate) name: String,
}

impl ObjectLink {
    /// The link, after the same checks as [`parse`].
    pub(crate) fn to_url(&self) -> Result<String, String> {
        self.validate()?;
        let group = if self.group.is_empty() {
            CORE_GROUP
        } else {
            &self.group
        };
        let namespace = if self.namespace.is_empty() {
            NO_NAMESPACE
        } else {
            &self.namespace
        };
        let parts = [
            self.context.as_str(),
            group,
            &self.version,
            &self.kind,
            namespace,
            &self.name,
        ];
        let path: Vec<String> = parts.iter().map(|p| encode(p)).collect();
        Ok(format!("{SCHEME}://{}", path.join("/")))
    }

    fn validate(&self) -> Result<(), String> {
        check_context(&self.context)?;
        if !self.group.is_empty() && !is_subdomain(&self.group) {
            return Err(format!("`{}` is not an API group", self.group));
        }
        if !is_label(&self.version) {
            return Err(format!("`{}` is not an API version", self.version));
        }
        if !is_kind(&self.kind) {
            return Err(format!("`{}` is not a kind", self.kind));
        }
        if !self.namespace.is_empty() && !is_label(&self.namespace) {
            return Err(format!("`{}` is not a namespace name", self.namespace));
        }
        if !is_object_name(&self.name) {
            return Err(format!("`{}` is not an object name", self.name));
        }
        Ok(())
    }
}

/// Read a link. The error says what is wrong with it, in words that can be
/// shown as they are.
pub(crate) fn parse(link: &str) -> Result<ObjectLink, String> {
    if link.len() > MAX_LINK {
        return Err(format!("the link is longer than {MAX_LINK} characters"));
    }
    let rest = strip_scheme(link).ok_or("it does not start with kubeloupe://")?;
    // Only unreserved characters, `%` escapes and the separators: no
    // query, fragment, spaces or anything a URL parser might read its own
    // way.
    if let Some(c) = rest
        .chars()
        .find(|c| !is_unreserved(*c) && *c != '%' && *c != '/')
    {
        return Err(match c {
            '?' | '#' => "it has a query or a fragment".to_string(),
            c if c.is_ascii_graphic() => format!("it has a `{c}` that is not percent-encoded"),
            _ => "it has a space or a character that is not plain ASCII".to_string(),
        });
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 6 {
        return Err(format!(
            "it has {} parts instead of 6 (context/group/version/kind/namespace/name)",
            parts.len()
        ));
    }
    let decoded = parts
        .iter()
        .map(|p| decode(p))
        .collect::<Result<Vec<String>, String>>()?;
    let [context, group, version, kind, namespace, name] =
        <[String; 6]>::try_from(decoded).expect("six parts");
    // `core` and `_` are the only spellings of "none": an empty part is a
    // typo or a trick.
    if let Some(i) = [&context, &group, &version, &kind, &namespace, &name]
        .iter()
        .position(|p| p.is_empty())
    {
        let what = [
            "context",
            "group (core for the core group)",
            "version",
            "kind",
            "namespace (_ for a cluster-scoped object)",
            "name",
        ][i];
        return Err(format!("its {what} is empty"));
    }
    let link = ObjectLink {
        context,
        group: if group == CORE_GROUP {
            String::new()
        } else {
            group
        },
        version,
        kind,
        namespace: if namespace == NO_NAMESPACE {
            String::new()
        } else {
            namespace
        },
        name,
    };
    link.validate()?;
    Ok(link)
}

/// Whether `arg` looks like a link at all (a launch argument to try).
pub(crate) fn is_link(arg: &str) -> bool {
    strip_scheme(arg).is_some()
}

fn strip_scheme(link: &str) -> Option<&str> {
    let (scheme, rest) = link.split_once("://")?;
    scheme.eq_ignore_ascii_case(SCHEME).then_some(rest)
}

fn is_unreserved(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')
}

fn encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for b in part.bytes() {
        if is_unreserved(char::from(b)) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Percent-decode one part. Every `%` must start an escape, and the result
/// is checked by the part's own rules afterwards.
fn decode(part: &str) -> Result<String, String> {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or("it has a `%` that does not start an escape like %2F")?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "it has an escape that is not text".to_string())
}

/// A context name: printable ASCII (spaces inside only), at most 253
/// characters. Context names have no rules of their own in a kubeconfig,
/// but no control, bidi or look-alike characters get into a notice through
/// a link.
fn check_context(context: &str) -> Result<(), String> {
    let printable = context.bytes().all(|b| (0x20..0x7f).contains(&b));
    if context.is_empty()
        || context.len() > MAX_CONTEXT
        || !printable
        || context.starts_with(' ')
        || context.ends_with(' ')
    {
        return Err(format!(
            "its context is not a name kubeloupe can link to (printable ASCII, at most {MAX_CONTEXT} characters)"
        ));
    }
    Ok(())
}

/// RFC 1123 label: lowercase letters, digits and `-`, starting and ending
/// with a letter or digit, at most 63 characters (namespaces, versions).
fn is_label(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// RFC 1123 subdomain: dot-separated labels, at most 253 characters
/// (API groups).
fn is_subdomain(s: &str) -> bool {
    s.len() <= 253 && s.split('.').all(is_label)
}

/// A kind: a letter, then letters and digits, at most 63 characters.
fn is_kind(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric())
}

/// An object name: a subdomain, plus `:` inside (RBAC names like
/// `system:kube-scheduler`), at most 253 characters.
fn is_object_name(s: &str) -> bool {
    let b = s.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 253
        && edge(b[0])
        && edge(b[b.len() - 1])
        && b.iter()
            .all(|c| edge(*c) || matches!(c, b'-' | b'.' | b':'))
        && !s.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(context: &str) -> ObjectLink {
        ObjectLink {
            context: context.into(),
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: "demo".into(),
            name: "web-7d9f-abcde".into(),
        }
    }

    #[test]
    fn round_trips() {
        let p = pod("kind-kubeloupe-test");
        let url = p.to_url().unwrap();
        assert_eq!(
            url,
            "kubeloupe://kind-kubeloupe-test/core/v1/Pod/demo/web-7d9f-abcde"
        );
        assert_eq!(parse(&url).unwrap(), p);

        let node = ObjectLink {
            group: "rbac.authorization.k8s.io".into(),
            version: "v1".into(),
            kind: "ClusterRole".into(),
            namespace: String::new(),
            name: "system:kube-scheduler".into(),
            ..pod("arn:aws:eks:eu-west-1:123456789012:cluster/prod one")
        };
        let url = node.to_url().unwrap();
        assert_eq!(
            url,
            "kubeloupe://arn%3Aaws%3Aeks%3Aeu-west-1%3A123456789012%3Acluster%2Fprod%20one/\
             rbac.authorization.k8s.io/v1/ClusterRole/_/system%3Akube-scheduler"
        );
        assert_eq!(parse(&url).unwrap(), node);
    }

    #[test]
    fn reads_what_a_browser_or_shell_hands_over() {
        // Scheme in another case, lowercase escapes.
        let p = parse("KubeLoupe://a%2fb/apps/v1/Deployment/demo/web").unwrap();
        assert_eq!(p.context, "a/b");
        assert_eq!(p.group, "apps");
    }

    #[test]
    fn refuses_malformed_links() {
        let bad = [
            "",
            "https://kind/core/v1/Pod/demo/web",
            "kubeloupe:kind/core/v1/Pod/demo/web",
            "kubeloupe://kind/core/v1/Pod/demo",
            "kubeloupe://kind/core/v1/Pod/demo/web/",
            "kubeloupe://kind/core/v1/Pod/demo/web/extra",
            "kubeloupe://kind/core/v1/Pod/demo/web?exec=sh",
            "kubeloupe://kind/core/v1/Pod/demo/web#x",
            "kubeloupe://kind/core/v1/Pod/demo/we b",
            "kubeloupe://kind/core/v1/Pod/demo/wéb",
            "kubeloupe://kind//v1/Pod/demo/web",
            "kubeloupe://kind/core/v1/Pod//web",
            "kubeloupe:///core/v1/Pod/demo/web",
            "kubeloupe://kind/core/v1/Pod/demo/%",
            "kubeloupe://kind/core/v1/Pod/demo/%zz",
            "kubeloupe://kind/core/v1/Pod/demo/%ff",
            "kubeloupe://kind/core/v1/Pod/demo/web;rm",
            "kubeloupe://kind/core/v1/Pod/demo/web\n",
        ];
        for link in bad {
            assert!(parse(link).is_err(), "{link:?} should be refused");
        }
    }

    #[test]
    fn checks_every_part_by_its_rules() {
        let base = "kubeloupe://kind";
        let bad = [
            // Group, version, kind.
            "/Apps/v1/Deployment/demo/web",
            "/apps..x/v1/Deployment/demo/web",
            "/apps/V1/Deployment/demo/web",
            "/apps/v1/Deploy-ment/demo/web",
            "/apps/v1/1Deployment/demo/web",
            // Namespace: a label, so no dots, upper case or `..`.
            "/core/v1/Pod/a.b/web",
            "/core/v1/Pod/Demo/web",
            "/core/v1/Pod/../web",
            "/core/v1/Pod/-demo/web",
            // Name.
            "/core/v1/Pod/demo/..",
            "/core/v1/Pod/demo/.web",
            "/core/v1/Pod/demo/Web",
            "/core/v1/Pod/demo/web%2Fx",
            "/core/v1/Pod/demo/web%00",
        ];
        for tail in bad {
            let link = format!("{base}{tail}");
            assert!(parse(&link).is_err(), "{link:?} should be refused");
        }
        // Length caps.
        let long_label = "a".repeat(64);
        assert!(parse(&format!("{base}/core/v1/Pod/{long_label}/web")).is_err());
        assert!(parse(&format!("{base}/core/v1/Pod/demo/{}", "a".repeat(254))).is_err());
        assert!(parse(&format!("{base}/core/v1/Pod/demo/{}", "a".repeat(253))).is_ok());
        assert!(parse(&format!(
            "kubeloupe://{}/core/v1/Pod/demo/web",
            "c".repeat(254)
        ))
        .is_err());
        assert!(parse(&format!("kubeloupe://{}", "a/".repeat(2000))).is_err());
    }

    #[test]
    fn context_names_stay_printable() {
        for ctx in [
            "%E2%80%AEevil",
            "a%0Ab",
            "a%09b",
            "%20lead",
            "trail%20",
            "a%7Fb",
        ] {
            let link = format!("kubeloupe://{ctx}/core/v1/Pod/demo/web");
            assert!(parse(&link).is_err(), "{link:?} should be refused");
        }
        assert!(pod("a\u{202e}b").to_url().is_err());
        assert!(pod("").to_url().is_err());
    }

    #[test]
    fn knows_a_link_argument() {
        assert!(is_link("kubeloupe://x"));
        assert!(is_link("KUBELOUPE://x"));
        assert!(!is_link("--flag"));
        assert!(!is_link("/usr/bin/kubeloupe"));
    }
}
