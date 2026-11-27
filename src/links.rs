//! `nauvi://` links to one object (#299):
//! `nauvi://<context>/<group>/<version>/<kind>/<namespace>/<name>`.
//!
//! `core` stands for the core group and `_` for "no namespace" (a
//! cluster-scoped object). The context is percent-encoded, as are the other
//! parts if they ever need it.
//!
//! Links come from anywhere (a chat, a web page, a ticket, an AI CLI's
//! output), so every part is checked here before anything looks at it:
//! Kubernetes' own name rules (DNS labels and subdomains) with their length
//! caps, a printable-ASCII context name, no query, fragment or extra
//! segment, and a cap on the whole link. A link only ever navigates: the
//! app opens the object's detail panel in a window on that context, if the
//! context is one of the user's.
//!
//! The app's "Copy link" and the CLI's `nauvi link` (#548) both build links
//! with [`object_link`]; `nauvi show` hands one to the running app.

use crate::resources::ResourceRef;
use serde::{Deserialize, Serialize};

pub const SCHEME: &str = "nauvi";

/// No link longer than this is read (the longest valid one is about 1.9 kB,
/// with a context of 253 characters that all need percent-encoding).
const MAX_LINK: usize = 2048;
const MAX_CONTEXT: usize = 253;
const CORE_GROUP: &str = "core";
const NO_NAMESPACE: &str = "_";
/// The name part of a kind's table in a `nauvi show` request: never an
/// object name (those start with a letter or digit).
const TABLE: &str = "_";

/// What an Ask AI terminal sets for `nauvi link` and `nauvi show` (#548):
/// the context's id in the app's catalog, and its name in the terminal's
/// kubeconfig. A link names the id, which differs from the name when two
/// kubeconfigs have a context of that name.
pub const LINK_CONTEXT_ENV: &str = "NAUVI_LINK_CONTEXT";
pub const LINK_KUBE_CONTEXT_ENV: &str = "NAUVI_LINK_KUBE_CONTEXT";

/// `nauvi show` (#548): the Ask AI session's token in its terminal's
/// environment (set only while "Let Ask AI open views" was on when the
/// session started), the app's own program, and the argument that starts
/// that program as a hand-over: `<program> --ask-ai-show <file> <request>`,
/// the file holding the token (`show_request.rs`).
pub const SHOW_SESSION_ENV: &str = "NAUVI_ASK_AI_SESSION";
pub const SHOW_APP_ENV: &str = "NAUVI_APP";
pub const SHOW_FLAG: &str = "--ask-ai-show";

/// What a link points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ObjectLink {
    /// The context's id in the catalog (its name, for the default kubeconfig).
    pub context: String,
    /// `""` for the core group.
    pub group: String,
    pub version: String,
    pub kind: String,
    /// `""` for a cluster-scoped object.
    pub namespace: String,
    pub name: String,
}

impl ObjectLink {
    /// The link, after the same checks as [`parse`].
    pub fn to_url(&self) -> Result<String, String> {
        self.validate(false)?;
        Ok(self.url())
    }

    /// A `nauvi show` request (#548): [`Self::to_url`], or with an empty
    /// `name` the kind's table (`_` in place of the name; an empty
    /// `namespace` is then every namespace).
    pub fn to_show_url(&self) -> Result<String, String> {
        self.validate(true)?;
        Ok(self.url())
    }

    /// Whether this is a kind's table ([`parse_show`] only), not one object.
    pub fn is_table(&self) -> bool {
        self.name.is_empty()
    }

    fn url(&self) -> String {
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
            if self.name.is_empty() {
                TABLE
            } else {
                &self.name
            },
        ];
        let path: Vec<String> = parts.iter().map(|p| encode(p)).collect();
        format!("{SCHEME}://{}", path.join("/"))
    }

    /// `table`: an empty name stands for the kind's table.
    fn validate(&self, table: bool) -> Result<(), String> {
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
        if !(table && self.name.is_empty()) && !is_object_name(&self.name) {
            return Err(format!("`{}` is not an object name", self.name));
        }
        Ok(())
    }
}

/// Read a link. The error says what is wrong with it, in words that can be
/// shown as they are.
pub fn parse(link: &str) -> Result<ObjectLink, String> {
    parse_with(link, false)
}

/// Read a `nauvi show` request ([`ObjectLink::to_show_url`]): a link, or a
/// kind's table (an empty name).
pub fn parse_show(link: &str) -> Result<ObjectLink, String> {
    parse_with(link, true)
}

fn parse_with(link: &str, table: bool) -> Result<ObjectLink, String> {
    if link.len() > MAX_LINK {
        return Err(format!("the link is longer than {MAX_LINK} characters"));
    }
    let rest = strip_scheme(link).ok_or("it does not start with nauvi://")?;
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
        name: if table && name == TABLE {
            String::new()
        } else {
            name
        },
    };
    link.validate(table)?;
    Ok(link)
}

/// The link to `name` of `resource` in `namespace` (`""`: cluster-scoped)
/// on the catalog context `context`: the app's "Copy link" and the CLI's
/// `nauvi link`.
pub fn object_link(
    context: &str,
    resource: &ResourceRef,
    namespace: &str,
    name: &str,
) -> Result<String, String> {
    object_ref(context, resource, namespace, name)
        .to_url()
        .map_err(|e| format!("This object can't be linked to: {e}."))
}

/// What a link to `name` (`""`: the kind's table) of `resource` points at.
pub fn object_ref(
    context: &str,
    resource: &ResourceRef,
    namespace: &str,
    name: &str,
) -> ObjectLink {
    ObjectLink {
        context: context.to_string(),
        group: resource.group.clone(),
        version: resource.version.clone(),
        kind: resource.kind.clone(),
        namespace: namespace.to_string(),
        name: name.to_string(),
    }
}

/// The context a link from the CLI names: `kube_context` (`--context`, or
/// the kubeconfig's current context), or in an Ask AI terminal the
/// catalog id the app set for that context ([`LINK_CONTEXT_ENV`]), while
/// the terminal's kubeconfig still selects it. `from_env` reads one
/// environment variable.
pub fn link_context(kube_context: &str, from_env: impl Fn(&str) -> Option<String>) -> String {
    match (from_env(LINK_KUBE_CONTEXT_ENV), from_env(LINK_CONTEXT_ENV)) {
        (Some(kube), Some(id)) if kube == kube_context && !id.is_empty() => id,
        _ => kube_context.to_string(),
    }
}

/// Whether `arg` looks like a link at all (a launch argument to try).
pub fn is_link(arg: &str) -> bool {
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
            "its context is not a name nauvi can link to (printable ASCII, at most {MAX_CONTEXT} characters)"
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
        let p = pod("kind-nauvi-test");
        let url = p.to_url().unwrap();
        assert_eq!(
            url,
            "nauvi://kind-nauvi-test/core/v1/Pod/demo/web-7d9f-abcde"
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
            "nauvi://arn%3Aaws%3Aeks%3Aeu-west-1%3A123456789012%3Acluster%2Fprod%20one/\
             rbac.authorization.k8s.io/v1/ClusterRole/_/system%3Akube-scheduler"
        );
        assert_eq!(parse(&url).unwrap(), node);
    }

    #[test]
    fn reads_what_a_browser_or_shell_hands_over() {
        // Scheme in another case, lowercase escapes.
        let p = parse("NaUvi://a%2fb/apps/v1/Deployment/demo/web").unwrap();
        assert_eq!(p.context, "a/b");
        assert_eq!(p.group, "apps");
    }

    #[test]
    fn refuses_malformed_links() {
        let bad = [
            "",
            "https://kind/core/v1/Pod/demo/web",
            "nauvi:kind/core/v1/Pod/demo/web",
            "nauvi://kind/core/v1/Pod/demo",
            "nauvi://kind/core/v1/Pod/demo/web/",
            "nauvi://kind/core/v1/Pod/demo/web/extra",
            "nauvi://kind/core/v1/Pod/demo/web?exec=sh",
            "nauvi://kind/core/v1/Pod/demo/web#x",
            "nauvi://kind/core/v1/Pod/demo/we b",
            "nauvi://kind/core/v1/Pod/demo/wéb",
            "nauvi://kind//v1/Pod/demo/web",
            "nauvi://kind/core/v1/Pod//web",
            "nauvi:///core/v1/Pod/demo/web",
            "nauvi://kind/core/v1/Pod/demo/%",
            "nauvi://kind/core/v1/Pod/demo/%zz",
            "nauvi://kind/core/v1/Pod/demo/%ff",
            "nauvi://kind/core/v1/Pod/demo/web;rm",
            "nauvi://kind/core/v1/Pod/demo/web\n",
        ];
        for link in bad {
            assert!(parse(link).is_err(), "{link:?} should be refused");
        }
    }

    #[test]
    fn checks_every_part_by_its_rules() {
        let base = "nauvi://kind";
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
        assert!(parse(&format!("nauvi://{}/core/v1/Pod/demo/web", "c".repeat(254))).is_err());
        assert!(parse(&format!("nauvi://{}", "a/".repeat(2000))).is_err());
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
            let link = format!("nauvi://{ctx}/core/v1/Pod/demo/web");
            assert!(parse(&link).is_err(), "{link:?} should be refused");
        }
        assert!(pod("a\u{202e}b").to_url().is_err());
        assert!(pod("").to_url().is_err());
    }

    #[test]
    fn knows_a_link_argument() {
        assert!(is_link("nauvi://x"));
        assert!(is_link("NAUVI://x"));
        assert!(!is_link("--flag"));
        assert!(!is_link("/usr/bin/nauvi"));
    }

    fn pods() -> ResourceRef {
        ResourceRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
        }
    }

    #[test]
    fn object_link_is_the_copy_link_format() {
        assert_eq!(
            object_link("kind-nauvi-test", &pods(), "demo", "web-7d9f-abcde").unwrap(),
            "nauvi://kind-nauvi-test/core/v1/Pod/demo/web-7d9f-abcde"
        );
        let err = object_link("kind", &pods(), "demo", "Web").unwrap_err();
        assert_eq!(
            err,
            "This object can't be linked to: `Web` is not an object name."
        );
        // No table link: a link is always one object.
        assert!(object_link("kind", &pods(), "demo", "").is_err());
    }

    #[test]
    fn show_requests_also_name_a_kinds_table() {
        let table = object_ref("kind", &pods(), "demo", "");
        let url = table.to_show_url().unwrap();
        assert_eq!(url, "nauvi://kind/core/v1/Pod/demo/_");
        let back = parse_show(&url).unwrap();
        assert!(back.is_table());
        assert_eq!(back, table);
        // A clicked link is never a table.
        assert!(parse(&url).is_err());
        assert!(table.to_url().is_err());
        // Every namespace.
        let all = object_ref("kind", &pods(), "", "");
        assert_eq!(all.to_show_url().unwrap(), "nauvi://kind/core/v1/Pod/_/_");
        // An object goes through unchanged, with the same checks.
        let one = parse_show("nauvi://kind/core/v1/Pod/demo/web").unwrap();
        assert_eq!(one.name, "web");
        assert!(parse_show("nauvi://kind/core/v1/Pod/demo/web?x").is_err());
        assert!(parse_show("nauvi://kind/core/v1/Pod/demo/__").is_err());
    }

    #[test]
    fn an_ask_ai_terminal_links_to_the_catalog_id() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                vars.iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(link_context("prod", env(&[])), "prod");
        let ask_ai = env(&[
            (LINK_KUBE_CONTEXT_ENV, "prod"),
            (LINK_CONTEXT_ENV, "prod (b.yaml)"),
        ]);
        assert_eq!(link_context("prod", ask_ai), "prod (b.yaml)");
        // The terminal's kubeconfig was switched to another context.
        assert_eq!(link_context("dev", ask_ai), "dev");
    }
}
