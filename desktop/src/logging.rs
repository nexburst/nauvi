//! The app log (#208): `kubeloupe.log` in the platform's log folder
//! (`app_log_dir`), with the app's `tracing` output, panics and the errors
//! the UI forwards.
//!
//! - Each event is passed through [`redact`] and then written as one line
//!   ([`event_line`]): newlines, control characters, bidi overrides and
//!   line separators become spaces, so text from a cluster or a page can't
//!   start a line of its own (#264). Panic backtraces and UI stacks are
//!   joined with " | ".
//! - The file is capped at [`MAX_BYTES`]; it then moves to `kubeloupe.1.log`
//!   (the older one to `.2`), so the folder never holds more than
//!   `KEEP + 1` files. If it can't be moved (another program holds it open
//!   on Windows), lines are dropped once it reaches [`HARD_MAX_BYTES`],
//!   until a rotation works again.
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
/// The size the log never grows past, even when it can't be rotated.
pub(crate) const HARD_MAX_BYTES: u64 = 2 * MAX_BYTES;
/// Room kept below [`HARD_MAX_BYTES`] for the note that lines are dropped.
const FULL_NOTE_ROOM: u64 = 1024;
/// One event's line is cut to this many bytes.
const MAX_LINE_BYTES: usize = 64 * 1024;
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
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let backtrace = joined_lines(&backtrace, 400);
        tracing::error!("panic in thread {thread}{place}: {message} | backtrace: {backtrace}");
        previous(info);
    }));
}

/// An error the UI forwarded: from a `<svelte:boundary>`, `onerror` or an
/// unhandled promise rejection. Logged on one line, the stack's frames
/// joined with " | ".
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
    let stack = joined_lines(&clip(stack, MAX_UI_STACK), 400);
    let stack = if stack.is_empty() {
        stack
    } else {
        format!(" | stack: {stack}")
    };
    tracing::error!(target: "kubeloupe_desktop::ui", "UI error ({source}) in window {window}: {message}{stack}");
}

/// `s` on one line, at most `max` characters: control characters
/// (newlines too), bidi overrides and isolates, line and paragraph
/// separators and other invisible characters
/// ([`kubeloupe::catalog::is_invisible`]) become spaces.
fn one_line(s: &str, max: usize) -> String {
    flatten(&clip(s, max))
}

fn flatten(s: &str) -> String {
    s.chars()
        .map(|c| {
            if kubeloupe::catalog::is_invisible(c) {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// The non-blank lines of `s`, each trimmed and cut to `max` characters,
/// joined with " | ".
fn joined_lines(s: &str, max: usize) -> String {
    s.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| one_line(l, max))
        .collect::<Vec<_>>()
        .join(" | ")
}

/// What is written for one formatted event: redacted, then on one line (a
/// message with a newline can't forge a line of its own), at most
/// [`MAX_LINE_BYTES`], ending in exactly one newline.
fn event_line(raw: &str) -> String {
    let text = redact(raw);
    let mut line = flatten(text.trim_end_matches(['\n', '\r']));
    if line.len() > MAX_LINE_BYTES - 4 {
        let mut cut = MAX_LINE_BYTES - 4;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
        line.push('…');
    }
    line.push('\n');
    line
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
        let text = event_line(&String::from_utf8_lossy(&self.buf));
        let _ = io::stderr().write_all(text.as_bytes());
        if let Some(file) = &self.sink.file {
            if let Ok(mut f) = file.lock() {
                f.write_line(text.as_bytes());
            }
        }
    }
}

/// `kubeloupe.log`, rotated at [`MAX_BYTES`], never past [`HARD_MAX_BYTES`].
pub(crate) struct RotatingFile {
    dir: PathBuf,
    file: File,
    len: u64,
    /// The last rotation failed (said once on stderr, until one works).
    rotate_failed: bool,
    /// Past the hard cap: lines are dropped until a rotation works.
    full: bool,
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
            rotate_failed: false,
            full: false,
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
            match self.rotate() {
                Ok(()) => {
                    self.rotate_failed = false;
                    self.full = false;
                }
                Err(e) => {
                    if !self.rotate_failed {
                        eprintln!("kubeloupe: could not rotate the log: {e}");
                        self.rotate_failed = true;
                    }
                    // Keep growing a little, but never past the hard cap.
                    let room = HARD_MAX_BYTES - FULL_NOTE_ROOM;
                    if self.len + line.len() as u64 > room {
                        if !self.full {
                            self.full = true;
                            self.note_full(&e);
                        }
                        return;
                    }
                }
            }
        }
        // One line is never longer than the cap.
        let line = &line[..line.len().min(MAX_BYTES as usize)];
        if self.file.write_all(line).is_ok() {
            self.len += line.len() as u64;
        }
    }

    /// Say once, at the end of the full log, that lines are dropped.
    fn note_full(&mut self, e: &io::Error) {
        let note = format!(
            "kubeloupe: the log could not be rotated ({}) and is full; lines are dropped until it can be\n",
            one_line(&e.to_string(), 200)
        );
        let note = &note.as_bytes()[..note.len().min(FULL_NOTE_ROOM as usize)];
        if self.file.write_all(note).is_ok() {
            self.len += note.len() as u64;
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

    /// Directories where the rotated logs go: renaming onto a non-empty
    /// one fails on every platform, like a log held open on Windows.
    fn block_rotation(dir: &Path) {
        for n in 1..=KEEP {
            let p = RotatingFile::path(dir, n);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("keep"), b"x").unwrap();
        }
    }

    #[test]
    fn stops_at_the_hard_cap_when_rotation_fails_and_resumes_after() {
        let dir = temp_dir("hardcap");
        let mut log = RotatingFile::open(&dir).unwrap();
        block_rotation(&dir);
        let line = vec![b'x'; 300 * 1024];
        for _ in 0..40 {
            log.write_line(&line);
        }
        let current = RotatingFile::path(&dir, 0);
        let len = std::fs::metadata(&current).unwrap().len();
        assert!(len > MAX_BYTES, "it grew past the soft cap: {len}");
        assert!(len <= HARD_MAX_BYTES, "never past the hard cap: {len}");
        let text = std::fs::read_to_string(&current).unwrap();
        assert_eq!(
            text.matches("lines are dropped").count(),
            1,
            "the note once"
        );

        // Once the rotated names are free again, it rotates and writes.
        for n in 1..=KEEP {
            std::fs::remove_dir_all(RotatingFile::path(&dir, n)).unwrap();
        }
        log.write_line(b"after\n");
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "after\n");
        assert!(RotatingFile::path(&dir, 1).is_file());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_event_is_one_line() {
        // A cluster message with a newline can't forge a log line.
        let raw = "2026-11-16T10:00:00Z  WARN kubeloupe: watch failed: boom\n2026-11-16T10:00:01Z  INFO kubeloupe: forged\r\n";
        let line = event_line(raw);
        assert_eq!(line.matches('\n').count(), 1, "{line:?}");
        assert!(line.ends_with("forged\n"), "{line:?}");
        assert!(line.contains("boom 2026-11-16T10:00:01Z"), "{line:?}");
        // Bidi overrides, isolates and line separators are spaces too.
        let line = event_line("a\u{202E}b\u{2066}c\u{2069}d\u{2028}e\u{2029}f\u{85}g\n");
        assert_eq!(line, "a b c d e f g\n");
        // Redacted before it is flattened (a PEM block spans lines).
        let line =
            event_line("key -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- done\n");
        assert!(!line.contains("abc"), "{line:?}");
        // Cut, on a character boundary, with one newline.
        let line = event_line(&"é".repeat(MAX_LINE_BYTES));
        assert!(line.len() <= MAX_LINE_BYTES, "{}", line.len());
        assert!(line.ends_with("…\n"));
    }

    #[test]
    fn stacks_and_backtraces_are_joined() {
        assert_eq!(
            joined_lines(
                "Error: x\n    at f (a.js:1)\n\n  at g\u{202E} (b.js:2)\n",
                100
            ),
            "Error: x | at f (a.js:1) | at g  (b.js:2)"
        );
    }

    #[test]
    fn ui_text_is_one_line_and_clipped() {
        assert_eq!(one_line("a\nb\u{1b}[31mc", 100), "a b [31mc");
        assert_eq!(one_line("x\u{202A}y\u{2028}z", 100), "x y z");
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("abc", 3), "abc");
    }
}
