//! The file a `nauvi show` hand-over carries its token in (#548).
//!
//! The single-instance hand-over passes the launch's arguments to the
//! running app, and arguments are in the process list for every local
//! user (`/proc/<pid>/cmdline`, `ps`). So the token is not an argument:
//! `nauvi show` writes it to a file only its user can read (a new folder,
//! 0700, in the temp folder; the file 0600) and passes the file's path
//! (`<app> --ask-ai-show <file> <request>`).
//!
//! The app opens that path once, for reading and writing, only as a
//! regular file (never through a link, never a FIFO or device), reads at
//! most [`MAX_TOKEN_LEN`] bytes and compares them with its live tokens.
//! Only when they are a live token does it write its answer, on that same
//! open file, replacing the token: so it only writes to the very file that
//! held a token, which only a holder of the token can have written. The
//! path is never opened a second time, so swapping a folder on it for a
//! link after the read can't send the answer anywhere else. `nauvi show` reads the answer, says what
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

/// Open `path` for reading and writing as an existing regular file, never
/// through a link (its last part) and without blocking on a FIFO.
fn open_regular(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: a link (or junction) is opened
        // itself, not followed; it is then not a regular file below.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(file)
}

/// A request file the app opened, with the token it held.
pub struct TokenFile {
    file: File,
    token: String,
}

impl TokenFile {
    /// Open the file at `path` (a regular file with at most
    /// [`MAX_TOKEN_LEN`] bytes) and read its token.
    pub fn open(path: &Path) -> Option<Self> {
        let file = open_regular(path).ok()?;
        let mut text = String::new();
        (&file)
            .take(MAX_TOKEN_LEN + 1)
            .read_to_string(&mut text)
            .ok()?;
        (text.len() as u64 <= MAX_TOKEN_LEN).then(|| Self {
            file,
            token: text.trim().to_string(),
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Write the app's answer over the token, in the file opened.
    pub fn answer(mut self, reply: &Reply) -> io::Result<()> {
        use std::io::{Seek, SeekFrom};
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(reply.to_text().as_bytes())
    }
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
        let file = TokenFile::open(&path).unwrap();
        assert_eq!(file.token(), "abc123");
        assert_eq!(request.reply(), None);
        file.answer(&Reply::Dropped("too soon\nreally".into()))
            .unwrap();
        assert_eq!(
            request.reply(),
            Some(Reply::Dropped("too soon really".into()))
        );
        TokenFile::open(&path)
            .unwrap()
            .answer(&Reply::Opened)
            .unwrap();
        assert_eq!(request.reply(), Some(Reply::Opened));
        let dir = path.parent().unwrap().to_path_buf();
        drop(request);
        assert!(!dir.exists());
    }

    #[test]
    fn reads_only_a_short_regular_file() {
        let request = RequestFile::create(&"a".repeat(200)).unwrap();
        assert!(TokenFile::open(request.path()).is_none(), "too long");
        let dir = request.path().parent().unwrap();
        assert!(TokenFile::open(dir).is_none(), "a folder");
        assert!(TokenFile::open(&dir.join("missing")).is_none());
        #[cfg(unix)]
        {
            let link = dir.join("link");
            std::os::unix::fs::symlink(request.path(), &link).unwrap();
            assert!(TokenFile::open(&link).is_none(), "never through a link");
        }
    }

    /// The answer goes to the file that held the token, even when the
    /// path's folder is swapped for a link to another folder in between.
    #[cfg(unix)]
    #[test]
    fn the_answer_never_follows_a_swapped_path() {
        let request = RequestFile::create("tok").unwrap();
        let dir = request.path().parent().unwrap().to_path_buf();
        let other = dir.with_extension("other");
        fs::create_dir(&other).unwrap();
        let victim = other.join("request");
        fs::write(&victim, "keep me").unwrap();

        let file = TokenFile::open(request.path()).unwrap();
        assert_eq!(file.token(), "tok");
        // Swap the folder for a link to the other one.
        let moved = dir.with_extension("moved");
        fs::rename(&dir, &moved).unwrap();
        std::os::unix::fs::symlink(&other, &dir).unwrap();
        file.answer(&Reply::Opened).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert_eq!(
            fs::read_to_string(moved.join("request")).unwrap(),
            "opened\n"
        );
        fs::remove_file(&dir).unwrap();
        fs::remove_dir_all(&moved).unwrap();
        fs::remove_dir_all(&other).unwrap();
    }
}
