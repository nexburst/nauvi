//! The file a `nauvi show` hand-over carries its token in (#548).
//!
//! The single-instance hand-over passes the launch's arguments to the
//! running app, and arguments are in the process list for every local
//! user (`/proc/<pid>/cmdline`, `ps`). So the token is not an argument:
//! `nauvi show` writes it to a file only its user can read (a new folder,
//! 0700, in the temp folder; the file 0600) and passes the file's path
//! (`<app> --ask-ai-show <file> <request>`).
//!
//! The app reads at most [`MAX_TOKEN_LEN`] bytes from that path, only from
//! a regular file (never through a link, never a FIFO or device), and
//! compares them with its live tokens. Only when they are a live token does
//! it write its answer into the same file, replacing the token: so it only
//! writes to a file that already held a token, which only a holder of the
//! token can have written. `nauvi show` reads the answer, says what
//! happened and exits non-zero when nothing was opened, then removes the
//! folder.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The longest token the app reads (its tokens are 64 hex characters).
pub const MAX_TOKEN_LEN: u64 = 128;

/// What the app answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// The view was opened.
    Opened,
    /// Nothing was opened, for this reason.
    Dropped(String),
}

impl Reply {
    fn to_text(&self) -> String {
        match self {
            Reply::Opened => "opened\n".to_string(),
            Reply::Dropped(why) => format!("dropped\n{}\n", why.replace('\n', " ")),
        }
    }

    /// `None` while the file still holds the token (no answer yet).
    fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        match lines.next()? {
            "opened" => Some(Reply::Opened),
            "dropped" => Some(Reply::Dropped(lines.next().unwrap_or("").to_string())),
            _ => None,
        }
    }
}

/// The token file of one `nauvi show`; dropping it removes its folder.
pub struct RequestFile {
    dir: PathBuf,
    file: PathBuf,
}

impl RequestFile {
    /// A new private folder in the temp folder, with the token in it.
    pub fn create(token: &str) -> io::Result<Self> {
        let base = std::env::temp_dir();
        let mut last = None;
        for attempt in 0..16u32 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let dir = base.join(format!(
                "nauvi-show-{}-{nanos:x}-{attempt}",
                std::process::id()
            ));
            match private_dir(&dir) {
                Ok(()) => {
                    let request = Self {
                        file: dir.join("request"),
                        dir,
                    };
                    write_new_private(&request.file, token.as_bytes())?;
                    return Ok(request);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| io::Error::other("no free folder name")))
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    /// The app's answer, once it wrote one.
    pub fn reply(&self) -> Option<Reply> {
        Reply::parse(&fs::read_to_string(&self.file).ok()?)
    }
}

impl Drop for RequestFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn private_dir(dir: &Path) -> io::Result<()> {
    // The user's own temp folder (%TEMP%) is private to them.
    fs::create_dir(dir)
}

fn write_new_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Open `path` as an existing regular file, never through a link and
/// without blocking on a FIFO.
fn open_regular(path: &Path, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    if write {
        options.write(true);
    } else {
        options.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("a link"));
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(file)
}

/// The token in the file at `path`, if it is a regular file with at most
/// [`MAX_TOKEN_LEN`] bytes.
pub fn read_token(path: &Path) -> Option<String> {
    let file = open_regular(path, false).ok()?;
    let mut text = String::new();
    file.take(MAX_TOKEN_LEN + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= MAX_TOKEN_LEN).then(|| text.trim().to_string())
}

/// Write the app's answer into the file at `path` (it must exist).
pub fn write_reply(path: &Path, reply: &Reply) -> io::Result<()> {
    let mut file = open_regular(path, true)?;
    file.set_len(0)?;
    file.write_all(reply.to_text().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_the_token_and_the_answer() {
        let request = RequestFile::create("abc123").unwrap();
        let path = request.path().to_path_buf();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
        assert_eq!(read_token(&path).as_deref(), Some("abc123"));
        assert_eq!(request.reply(), None);
        write_reply(&path, &Reply::Dropped("too soon\nreally".into())).unwrap();
        assert_eq!(
            request.reply(),
            Some(Reply::Dropped("too soon really".into()))
        );
        write_reply(&path, &Reply::Opened).unwrap();
        assert_eq!(request.reply(), Some(Reply::Opened));
        let dir = path.parent().unwrap().to_path_buf();
        drop(request);
        assert!(!dir.exists());
    }

    #[test]
    fn reads_only_a_short_regular_file() {
        let request = RequestFile::create(&"a".repeat(200)).unwrap();
        assert_eq!(read_token(request.path()), None, "too long");
        let dir = request.path().parent().unwrap();
        assert_eq!(read_token(dir), None, "a folder");
        assert_eq!(read_token(&dir.join("missing")), None);
        assert!(write_reply(&dir.join("missing"), &Reply::Opened).is_err());
        #[cfg(unix)]
        {
            let link = dir.join("link");
            std::os::unix::fs::symlink(request.path(), &link).unwrap();
            assert_eq!(read_token(&link), None, "never through a link");
            assert!(write_reply(&link, &Reply::Opened).is_err());
        }
    }
}
