//! The settings of image security (#534, ADR 0011): off by default, for
//! the app and per context.

use nauvi::image_security::Severity;
use serde::{Deserialize, Serialize};
use specta::Type;

/// What `cache_ttl_hours` may be: an hour to a week.
pub(crate) const CACHE_TTL_RANGE: (u32, u32) = (1, 7 * 24);

/// Settings → Image security.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default)]
pub(crate) struct ImageSecuritySettings {
    /// Read the Trivy Operator's reports for clusters left on "default".
    /// Off: nothing is read anywhere unless a cluster turns it on.
    pub(crate) enabled: bool,
    /// Count (and show) only vulnerabilities this bad or worse.
    pub(crate) min_severity: Severity,
    /// Count only what has a fixed version.
    pub(crate) only_fixable: bool,
    /// Namespaces whose images are never shown (`kube-system`...).
    pub(crate) excluded_namespaces: Vec<String>,
    /// How long a listing is reused before the reports are read again
    /// (Refresh always reads them), within `CACHE_TTL_RANGE`.
    pub(crate) cache_ttl_hours: u32,
}

impl Default for ImageSecuritySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            min_severity: Severity::High,
            only_fixable: false,
            excluded_namespaces: Vec::new(),
            cache_ttl_hours: 24,
        }
    }
}

impl ImageSecuritySettings {
    /// Kept in range, the namespaces trimmed, without empty or repeated
    /// ones.
    pub(crate) fn normalized(mut self) -> Self {
        self.cache_ttl_hours = self
            .cache_ttl_hours
            .clamp(CACHE_TTL_RANGE.0, CACHE_TTL_RANGE.1);
        let mut seen: Vec<String> = Vec::new();
        for ns in self.excluded_namespaces {
            let ns = ns.trim().to_string();
            if !ns.is_empty() && !seen.contains(&ns) {
                seen.push(ns);
            }
        }
        self.excluded_namespaces = seen;
        self
    }
}

/// A cluster's own choice (its cluster settings), over the app's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ImageSecurityMode {
    /// As Settings → Image security says.
    #[default]
    Default,
    On,
    Off,
}

impl ImageSecurityMode {
    /// Whether reports are read for a cluster with this choice.
    pub(crate) fn enabled(self, app: &ImageSecuritySettings) -> bool {
        match self {
            ImageSecurityMode::Default => app.enabled,
            ImageSecurityMode::On => true,
            ImageSecurityMode::Off => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{parse, ContextSettings, Settings, SettingsPatch};

    #[test]
    fn off_by_default_with_high_and_a_day() {
        let s = Settings::default();
        assert!(!s.image_security.enabled);
        assert_eq!(s.image_security.min_severity, Severity::High);
        assert!(!s.image_security.only_fixable);
        assert_eq!(s.image_security.cache_ttl_hours, 24);
        assert!(!s.image_security_enabled("any"));
        // A file from before it has none: off.
        let old = parse(r#"{"version":1,"contexts":{"dev":{"view":"overview"}}}"#).unwrap();
        assert!(!old.image_security_enabled("dev"));
        assert_eq!(old.contexts["dev"].image_security, ImageSecurityMode::Default);
    }

    #[test]
    fn a_cluster_overrides_the_app() {
        let mut s = Settings::default();
        let ctx = |mode| ContextSettings {
            image_security: mode,
            ..Default::default()
        };
        s.contexts.insert("on".into(), ctx(ImageSecurityMode::On));
        s.contexts.insert("off".into(), ctx(ImageSecurityMode::Off));
        s.contexts.insert("dflt".into(), ctx(ImageSecurityMode::Default));
        assert!(s.image_security_enabled("on"));
        assert!(!s.image_security_enabled("off"));
        assert!(!s.image_security_enabled("dflt"));
        s.image_security.enabled = true;
        assert!(s.image_security_enabled("dflt"));
        assert!(s.image_security_enabled("unknown"));
        assert!(!s.image_security_enabled("off"));
    }

    #[test]
    fn a_patch_is_kept_in_range() {
        let mut s = Settings::default();
        let patch: SettingsPatch = serde_json::from_str(
            r#"{"image_security":{"enabled":true,"min_severity":"critical","only_fixable":true,
                "excluded_namespaces":[" kube-system ","","kube-system","istio"],"cache_ttl_hours":0}}"#,
        )
        .unwrap();
        s.apply(patch);
        let i = &s.image_security;
        assert!(i.enabled && i.only_fixable);
        assert_eq!(i.min_severity, Severity::Critical);
        assert_eq!(i.excluded_namespaces, ["kube-system", "istio"]);
        assert_eq!(i.cache_ttl_hours, 1);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["image_security"]["min_severity"], "critical");
    }
}
