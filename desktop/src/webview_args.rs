//! WebView2 browser arguments from the environment (#93).
//!
//! WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the app
//! passes its own arguments, and wry always does. msedgedriver (under
//! tauri-driver) starts the app with `--remote-debugging-port=0` in that
//! variable and waits for the port, so without this a WebDriver session on
//! Windows fails with "DevToolsActivePort file doesn't exist".
//!
//! When the variable is set, every window gets wry's default arguments plus
//! the variable's. All webviews of the app share one WebView2 environment,
//! so they must all get the same arguments.

/// The environment variable WebView2 documents for extra browser arguments.
pub(crate) const ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// wry's arguments when the app passes none (wry's `webview2/mod.rs`).
const WRY_DEFAULT_FEATURES: &str = "msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The arguments for every window, or `None` to keep wry's defaults.
pub(crate) fn from_env() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let extra = std::env::var(ENV).ok()?;
    merge(&extra)
}

/// wry's defaults plus `extra`. Chromium honours only the last
/// `--disable-features`, so both lists are merged into one.
fn merge(extra: &str) -> Option<String> {
    let extra = extra.trim();
    if extra.is_empty() {
        return None;
    }
    let mut features: Vec<&str> = WRY_DEFAULT_FEATURES.split(',').collect();
    let mut args = Vec::new();
    for arg in extra.split_whitespace() {
        match arg.strip_prefix("--disable-features=") {
            Some(list) => {
                for f in list.split(',').filter(|f| !f.is_empty()) {
                    if !features.contains(&f) {
                        features.push(f);
                    }
                }
            }
            None => args.push(arg),
        }
    }
    let mut out = format!("--disable-features={}", features.join(","));
    for arg in args {
        out.push(' ');
        out.push_str(arg);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::merge;

    #[test]
    fn nothing_set_keeps_the_defaults() {
        assert_eq!(merge(""), None);
        assert_eq!(merge("  "), None);
    }

    #[test]
    fn the_driver_arguments_are_added_and_features_merged() {
        let args = merge(
            "--enable-automation --disable-features=IgnoreDuplicateNavs,Prewarm \
             --remote-debugging-port=0 --disable-features=msWebOOUI",
        )
        .unwrap();
        assert_eq!(
            args,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,\
             IgnoreDuplicateNavs,Prewarm --enable-automation --remote-debugging-port=0"
        );
    }
}
