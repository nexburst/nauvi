//! WebKitGTK settings from the environment, chosen at start-up (#353).
//!
//! Without a GPU (no DRM render node: virtual machines, remote desktops,
//! CI), WebKitGTK's DMA-BUF renderer draws with Mesa's software rasterizer
//! into buffers in the web process's own memory: about 170 MB of the idle
//! web process's 380 MB on a GitHub runner. Its shared-memory renderer
//! shows the same pages for a fraction of that, so without a render node
//! the app turns the DMA-BUF renderer off. With a GPU those buffers live in
//! GPU memory and nothing changes. A `WEBKIT_DISABLE_DMABUF_RENDERER` the
//! user set, to anything, is kept.
//!
//! Without a render node the app process also keeps Mesa out (#353, round
//! 2): GTK opens GLX when it opens the display, and WebKit opens an EGL
//! display to look up the render node it hands the web process. Both load
//! Mesa's software rasterizer, whose libLLVM alone is about 45 MB resident,
//! for nothing: the app process draws the web process's shared-memory
//! buffers with cairo. `GDK_GL=disable` stops GTK's GLX, and naming the
//! render node (`/dev/null`: there is none) stops WebKit's lookup. The web
//! process still renders with Mesa as before. A value the user set is kept.

use std::path::Path;
use std::sync::OnceLock;

/// The WebKitGTK variable that turns the DMA-BUF renderer off.
const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// What the app sets without a render node, on top of [`DISABLE_DMABUF`].
const NO_GPU_EXTRA: &[(&str, &str)] = &[
    // GTK 3: no GLX (or EGL) at display open.
    ("GDK_GL", "disable"),
    // WebKit's UI process: the render node, so it opens no EGL display.
    ("WEBKIT_WEB_RENDER_DEVICE_FILE", "/dev/null"),
];

/// The variables [`apply`] set, for child processes that should not
/// inherit them (the local terminal).
static SET_BY_APP: OnceLock<Vec<&'static str>> = OnceLock::new();

/// What [`apply`] did, for the app log (logging starts later).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Renderer {
    /// Not Linux, or the user set the variable: left alone.
    Unchanged,
    /// A render node exists: WebKit's default (DMA-BUF) renderer.
    Gpu,
    /// No render node: the DMA-BUF renderer is off.
    NoGpu,
}

/// Whether `/dev/dri` (or `dir`) has a DRM render node (`renderD128`, ...).
fn has_render_node(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("renderD"))
        })
        .unwrap_or(false)
}

/// The decision for `user_value` (the variable as the user set it) and
/// whether a render node exists.
fn decide(user_value: Option<std::ffi::OsString>, render_node: bool) -> Renderer {
    match (user_value, render_node) {
        (Some(_), _) => Renderer::Unchanged,
        (None, true) => Renderer::Gpu,
        (None, false) => Renderer::NoGpu,
    }
}

/// Set WebKitGTK's variables. Call at the start of `main`, before any
/// thread starts (it changes the process environment) and before WebKit
/// loads.
pub(crate) fn apply() -> Renderer {
    if !cfg!(target_os = "linux") {
        return Renderer::Unchanged;
    }
    let renderer = decide(
        std::env::var_os(DISABLE_DMABUF),
        has_render_node(Path::new("/dev/dri")),
    );
    let mut set = Vec::new();
    if renderer == Renderer::NoGpu {
        std::env::set_var(DISABLE_DMABUF, "1");
        set.push(DISABLE_DMABUF);
        for &(var, value) in NO_GPU_EXTRA {
            if std::env::var_os(var).is_none() {
                std::env::set_var(var, value);
                set.push(var);
            }
        }
    }
    let _ = SET_BY_APP.set(set);
    renderer
}

/// The variables the app set for WebKitGTK (not the user): the local
/// terminal removes them, so programs started there don't inherit them.
pub(crate) fn set_by_app() -> &'static [&'static str] {
    SET_BY_APP.get().map(Vec::as_slice).unwrap_or(&[])
}

/// One line in the app log about the choice.
pub(crate) fn log(renderer: Renderer) {
    match renderer {
        Renderer::Unchanged => {}
        Renderer::Gpu => tracing::info!("webview: GPU render node found, DMA-BUF renderer"),
        Renderer::NoGpu => tracing::info!(
            "webview: no GPU render node, DMA-BUF renderer off and no GL in the app process to save memory ({})",
            set_by_app().join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_users_choice_wins() {
        assert_eq!(decide(Some("0".into()), false), Renderer::Unchanged);
        assert_eq!(decide(Some("1".into()), true), Renderer::Unchanged);
    }

    #[test]
    fn without_a_render_node_the_dmabuf_renderer_is_off() {
        assert_eq!(decide(None, false), Renderer::NoGpu);
        assert_eq!(decide(None, true), Renderer::Gpu);
    }

    #[test]
    fn render_nodes_are_found_by_name() {
        let dir = std::env::temp_dir().join(format!("nauvi-353-dri-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("card0"), "").unwrap();
        assert!(!has_render_node(&dir));
        std::fs::write(dir.join("renderD128"), "").unwrap();
        assert!(has_render_node(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!has_render_node(&dir));
    }
}
