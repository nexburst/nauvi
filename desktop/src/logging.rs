//! The app log (#208): `kubeloupe.log` in the platform's log folder
//! (`app_log_dir`), with the app's `tracing` output, panics and the errors
//! the UI forwards.
//!
//! - Each line is passed through [`redact`] before it is written, so a
//!   token, a password or a key that slips into a message is masked.
//! - The file is capped at [`MAX_BYTES`]; it then moves to `kubeloupe.1.log`
//!   (the older one to `.2`), so the folder never holds more than
//!   `KEEP + 1` files.
//! - On Unix the files are 0600 and the folder 0700.
//! - Only kubeloupe's own events at `info` and up are kept, and other crates'
//!   at `warn` and up (their debug output can carry request details).
//!   `KUBELOUPE_LOG=debug` raises kubeloupe's own level only.
//!
//! The lines also go to stderr, for runs from a terminal.

use crate::redact::redact;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tracing::level_filters::LevelFilter;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;

/// The log's name in its folder.
pub(crate) const LOG_FILE: &str = "kubeloupe.log";
/// The size at which the log is rotated.
pub(crate) const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// How many rotated logs are kept.
pub(crate) const KEEP: usize = 2;
/// At most this many UI errors are logged per run (a render loop that
/// throws would otherwise fill the log).
const MAX_UI_ERRORS: usize = 200;
/// A UI error's message and stack are cut to these lengths.
const MAX_UI_MESSAGE: usize = 1_000;
const MAX_UI_STACK: usize = 4_000;

/// The log folder, once `init` ran with one.
static DIR: OnceLock<PathBuf> = OnceLock::new();
static UI_ERRORS: AtomicUsize = AtomicUsize::new(0);

/// The log folder, if the app has one.
pub(crate) fn dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

/// Install the subscriber and the panic hook. `dir`: `app_log_dir`, or
/// `None` when the platform has none (then only stderr gets the lines).
pub(crate) fn init(dir: Option<PathBuf>) {
    let file = dir.and_then(|dir| match RotatingFile::open(&dir) {
        Ok(f) => {
            let _ = DIR.set(dir);
            Some(f)
        }
        Err(e) => {
            eprintln!(
                "kubeloupe: could not open the log in {}: {e}",
                dir.display()
            );
            None
        }
    });
    let own = match std::env::var("KUBELOUPE_LOG").ok().as_deref() {
        Some("debug") => LevelFilter::DEBUG,
        Some("trace") => LevelFilter::TRACE,
        _ => LevelFilter::INFO,
    };
    let filter = Targets::new()
        .with_default(LevelFilter::WARN)
        .with_target("kubeloupe", own)
        .with_target("kubeloupe_desktop", own);
    let layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(Sink {
            file: file.map(Mutex::new),
        });
    let _ = tracing_subscriber::registry()
        .with(layer.with_filter(filter))
        .try_init();
    install_panic_hook();
    tracing::info!("{}", crate::diagnostics::summary_line());
}

/// Log panics (message, place, backtrace) before the default hook runs.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("unnamed");
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!("panic in thread {thread}{place}: {message}\n{backtrace}");
        previous(info);
    }));
}

/// An error the UI forwarded: from a `<svelte:boundary>`, `onerror` or an
/// unhandled promise rejection. Logged on one line plus the stack.
pub(crate) fn ui_error(window: &str, source: &str, message: &str, stack: &str) {
    let n = UI_ERRORS.fetch_add(1, Ordering::Relaxed);
    if n == MAX_UI_ERRORS {
        tracing::warn!("{MAX_UI_ERRORS} UI errors logged; further ones are not");
    }
    if n >= MAX_UI_ERRORS {
        return;
    }
    let source: String = one_line(source, 32);
    let message = one_line(message, MAX_UI_MESSAGE);
    let stack: String = clip(stack, MAX_UI_STACK)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| format!("\n    {}", one_line(l, 400)))
        .collect();
    tracing::error!(target: "kubeloupe_desktop::ui", "UI error ({source}) in window {window}: {message}{stack}");
}

/// `s` on one line (control characters and newlines as spaces), at most
/// `max` characters.
fn one_line(s: &str, max: usize) -> String {
    clip(s, max)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// At most `max` characters of `s`, with "…" when cut.
fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Where the formatted lines go: stderr, and the log file if there is one.
struct Sink {
    file: Option<Mutex<RotatingFile>>,
}

impl<'a> MakeWriter<'a> for Sink {
    type Writer = Line<'a>;
    fn make_writer(&'a self) -> Line<'a> {
        Line {
            sink: self,
            buf: Vec::new(),
        }
    }
}

/// One event's text, written (redacted) when the formatter drops it.
struct Line<'a> {
    sink: &'a Sink,
    buf: Vec<u8>,
}

impl Write for Line<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Line<'_> {
    fn drop(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let text = redact(&String::from_utf8_lossy(&self.buf));
        let _ = io::stderr().write_all(text.as_bytes());
        if let Some(file) = &self.sink.file {
            if let Ok(mut f) = file.lock() {
                f.write_line(text.as_bytes());
            }
        }
    }
}

/// `kubeloupe.log`, rotated at [`MAX_BYTES`].
pub(crate) struct RotatingFile {
    dir: PathBuf,
    file: File,
    len: u64,
}

impl RotatingFile {
    pub(crate) fn open(dir: &Path) -> io::Result<Self> {
        create_private_dir(dir)?;
        let file = open_private(&dir.join(LOG_FILE))?;
        let len = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_path_buf(),
            file,
            len,
        })
    }

    /// The path of rotated log `n` (`0`: the current one).
    pub(crate) fn path(dir: &Path, n: usize) -> PathBuf {
        match n {
            0 => dir.join(LOG_FILE),
            n => dir.join(format!("kubeloupe.{n}.log")),
        }
    }

    pub(crate) fn write_line(&mut self, line: &[u8]) {
        if self.len > 0 && self.len + line.len() as u64 > MAX_BYTES {
            if let Err(e) = self.rotate() {
                eprintln!("kubeloupe: could not rotate the log: {e}");
            }
        }
        // One line is never longer than the cap.
        let line = &line[..line.len().min(MAX_BYTES as usize)];
        if self.file.write_all(line).is_ok() {
            self.len += line.len() as u64;
        }
    }

    fn rotate(&mut self) -> io::Result<()> {
        for n in (1..KEEP).rev() {
            let from = Self::path(&self.dir, n);
            if from.exists() {
                std::fs::rename(&from, Self::path(&self.dir, n + 1))?;
            }
        }
        std::fs::rename(Self::path(&self.dir, 0), Self::path(&self.dir, 1))?;
        self.file = open_private(&Self::path(&self.dir, 0))?;
        self.len = 0;
        Ok(())
    }
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Open `path` for appending, readable only by the user on Unix (also when
/// an older run left it wider).
fn open_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let file = options.open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    #[cfg(not(unix))]
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kubeloupe-208-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_two() {
        let dir = temp_dir("rotate");
        let mut log = RotatingFile::open(&dir).unwrap();
        let line = vec![b'x'; 1024 * 1024];
        for _ in 0..9 {
            log.write_line(&line);
        }
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(files.len(), KEEP + 1, "{files:?}");
        for n in 0..=KEEP {
            let len = std::fs::metadata(RotatingFile::path(&dir, n))
                .unwrap()
                .len();
            assert!(len <= MAX_BYTES, "file {n}: {len} bytes");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_line_longer_than_the_cap_is_cut() {
        let dir = temp_dir("long");
        let mut log = RotatingFile::open(&dir).unwrap();
        log.write_line(&vec![b'y'; MAX_BYTES as usize + 10]);
        assert_eq!(
            std::fs::metadata(dir.join(LOG_FILE)).unwrap().len(),
            MAX_BYTES
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        std::fs::create_dir_all(&dir).unwrap();
        // An older, world-readable log is tightened.
        std::fs::write(dir.join(LOG_FILE), b"old\n").unwrap();
        std::fs::set_permissions(dir.join(LOG_FILE), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        let mut log = RotatingFile::open(&dir).unwrap();
        log.write_line(&vec![b'z'; MAX_BYTES as usize]);
        log.write_line(b"next\n");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&RotatingFile::path(&dir, 0)), 0o600);
        assert_eq!(mode(&RotatingFile::path(&dir, 1)), 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ui_text_is_one_line_and_clipped() {
        assert_eq!(one_line("a\nb\u{1b}[31mc", 100), "a b [31mc");
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("abc", 3), "abc");
    }
}
