//! The single-instance hand-over on macOS (#555): a Unix socket in a
//! directory only this user can write, in place of the plugin's fixed
//! `/tmp/<identifier>_si.sock`, which another local user could create first
//! and so keep nauvi from starting or receive its links and `nauvi show`
//! requests.
//!
//! - The socket is `<per-user temp dir>/<identifier>.si/sock`. The temp dir
//!   is the one macOS gives each user (`confstr(_CS_DARWIN_USER_TEMP_DIR)`,
//!   `/var/folders/...`; else `$TMPDIR`). The `.si` directory is created
//!   0700 and must be a real directory owned by this user with no access for
//!   group or others; otherwise nauvi starts without single-instance.
//! - Before connecting, the socket file must be a socket owned by this user,
//!   and after connecting the listener on the other end must run as this
//!   user (`getpeereid`); otherwise nauvi sends nothing and starts normally.
//! - The running app only accepts connections from this user.
//!
//! The wire format is the plugin's: the working directory, `\0\0`, then the
//! arguments joined by `\0`. Linux and Windows keep the plugin.

use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `sun_path` holds 104 bytes on macOS, with the trailing NUL.
const MAX_SOCKET_PATH: usize = 103;
/// A hand-over is a working directory and a few arguments.
const MAX_MESSAGE: u64 = 1 << 20;
/// A client that connects and sends nothing doesn't hold up the next one.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// The directory that holds the socket: under the first absolute candidate
/// (the per-user temp dir macOS reports, then `$TMPDIR`).
pub(super) fn socket_dir(candidates: &[Option<String>], identifier: &str) -> Option<PathBuf> {
    let base = candidates
        .iter()
        .flatten()
        .map(|s| s.trim_end_matches('/'))
        .find(|s| s.starts_with('/') && s.len() > 1)?;
    let name: String = identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Some(Path::new(base).join(format!("{name}.si")))
}

/// Why a directory or socket is not this user's alone.
pub(super) fn check_dir(meta: &std::fs::Metadata, uid: u32) -> Result<(), String> {
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("is not a directory".into());
    }
    if meta.uid() != uid {
        return Err("belongs to another user".into());
    }
    if meta.mode() & 0o077 != 0 {
        return Err(format!(
            "is open to other users (mode {:o})",
            meta.mode() & 0o777
        ));
    }
    Ok(())
}

pub(super) fn check_socket(meta: &std::fs::Metadata, uid: u32) -> Result<(), String> {
    if !meta.file_type().is_socket() {
        return Err("is not a socket".into());
    }
    if meta.uid() != uid {
        return Err("belongs to another user".into());
    }
    Ok(())
}

/// Creates the directory 0700 if it is missing, then checks it.
pub(super) fn private_dir(dir: &Path, uid: u32) -> Result<(), String> {
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot be created: {e}")),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("cannot be read: {e}"))?;
    check_dir(&meta, uid)
}

/// What this launch does with the socket.
#[derive(Debug)]
pub(super) enum Start {
    /// Another copy runs and has the message: exit.
    HandedOver,
    /// No copy runs: listen on this socket.
    First(UnixListener),
    /// Start normally without single-instance, for this reason.
    Alone(String),
}

/// Hands `message` to the running copy, or claims the socket.
pub(super) fn start(dir: &Path, uid: u32, message: &[u8]) -> Start {
    if let Err(why) = private_dir(dir, uid) {
        return Start::Alone(format!("{} {why}", dir.display()));
    }
    let socket = dir.join("sock");
    if socket.as_os_str().len() > MAX_SOCKET_PATH {
        return Start::Alone(format!("{} is too long for a socket", socket.display()));
    }
    match std::fs::symlink_metadata(&socket) {
        Err(e) if e.kind() == ErrorKind::NotFound => return claim(&socket),
        Err(e) => return Start::Alone(format!("{} cannot be read: {e}", socket.display())),
        Ok(meta) => {
            if let Err(why) = check_socket(&meta, uid) {
                return Start::Alone(format!("{} {why}", socket.display()));
            }
        }
    }
    match UnixStream::connect(&socket) {
        Ok(stream) => match send(&stream, uid, message) {
            Ok(()) => Start::HandedOver,
            Err(e) => Start::Alone(format!("cannot hand over to the running app: {e}")),
        },
        // Left behind by a copy that crashed.
        Err(e) if matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::NotFound) => {
            let _ = std::fs::remove_file(&socket);
            claim(&socket)
        }
        Err(e) => Start::Alone(format!("cannot connect to {}: {e}", socket.display())),
    }
}

fn claim(socket: &Path) -> Start {
    match UnixListener::bind(socket) {
        Ok(listener) => Start::First(listener),
        Err(e) => Start::Alone(format!("cannot listen on {}: {e}", socket.display())),
    }
}

fn send(mut stream: &UnixStream, uid: u32, message: &[u8]) -> io::Result<()> {
    let peer = peer_uid(stream)?;
    if peer != uid {
        return Err(io::Error::other("the socket is served by another user"));
    }
    stream.write_all(message)?;
    stream.shutdown(std::net::Shutdown::Write)
}

/// Reads one hand-over from this user; `None` for anyone else's connection
/// or a broken one.
pub(super) fn receive(mut stream: UnixStream, uid: u32) -> Option<(String, Vec<String>)> {
    match peer_uid(&stream) {
        Ok(peer) if peer == uid => {}
        Ok(_) => {
            tracing::warn!("single-instance: refused a connection from another user");
            return None;
        }
        Err(e) => {
            tracing::warn!("single-instance: cannot tell who connected: {e}");
            return None;
        }
    }
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let mut bytes = Vec::new();
    if let Err(e) = (&mut stream).take(MAX_MESSAGE).read_to_end(&mut bytes) {
        tracing::warn!("single-instance: cannot read the hand-over: {e}");
        return None;
    }
    Some(decode(&String::from_utf8_lossy(&bytes)))
}

pub(super) fn encode(cwd: &str, args: &[String]) -> Vec<u8> {
    format!("{cwd}\0\0{}", args.join("\0")).into_bytes()
}

pub(super) fn decode(message: &str) -> (String, Vec<String>) {
    let (cwd, args) = message.split_once("\0\0").unwrap_or_default();
    (
        cwd.to_string(),
        args.split('\0').map(String::from).collect(),
    )
}

pub(super) fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    // SAFETY: a valid socket and two out-pointers to live locals.
    let r = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if r == 0 {
        Ok(uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: a valid socket, and `cred`/`len` describe a live buffer of the
    // size SO_PEERCRED writes.
    let r = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if r == 0 {
        Ok(cred.uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The per-user temp dir macOS gives this user, without `$TMPDIR`.
#[cfg(target_os = "macos")]
pub(super) fn darwin_user_temp_dir() -> Option<String> {
    let mut buf = vec![0u8; 1024];
    // SAFETY: `buf` is a live buffer of the length passed.
    let n = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n == 0 || n > buf.len() {
        return None;
    }
    buf.truncate(n - 1);
    String::from_utf8(buf).ok()
}

/// The plugin on macOS: hands over and exits, or listens for later launches
/// and runs `on_launch` with their working directory and arguments.
#[cfg(target_os = "macos")]
pub(super) fn plugin<F>(identifier: &str, on_launch: F) -> tauri::plugin::TauriPlugin<tauri::Wry>
where
    F: Fn(&tauri::AppHandle, Vec<String>, String) + Send + Sync + 'static,
{
    use tauri::Manager;
    let identifier = identifier.to_string();
    tauri::plugin::Builder::new("single-instance")
        .setup(move |app, _api| {
            let candidates = [darwin_user_temp_dir(), std::env::var("TMPDIR").ok()];
            let Some(dir) = socket_dir(&candidates, &identifier) else {
                tracing::warn!("single-instance: no per-user temp directory; starting without it");
                return Ok(());
            };
            let uid = current_uid();
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args_os()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            match start(&dir, uid, &encode(&cwd.to_string_lossy(), &args)) {
                Start::HandedOver => std::process::exit(0),
                Start::Alone(why) => {
                    tracing::warn!("single-instance: {why}; starting without it");
                }
                Start::First(listener) => {
                    // Removed when the app exits (`cleanup_before_exit`
                    // clears the resource table), so a restart can claim it.
                    app.resources_table().add(SocketLock(dir.join("sock")));
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        for stream in listener.incoming() {
                            match stream {
                                Ok(stream) => {
                                    if let Some((cwd, args)) = receive(stream, uid) {
                                        on_launch(&app, args, cwd);
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("single-instance: accept failed: {e}");
                                    std::thread::sleep(Duration::from_millis(200));
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .build()
}

/// Owns the socket file of the running app.
#[cfg(target_os = "macos")]
struct SocketLock(PathBuf);

#[cfg(target_os = "macos")]
impl tauri::Resource for SocketLock {}

#[cfg(target_os = "macos")]
impl Drop for SocketLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fresh directory under the system temp dir (short, for sun_path).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nauvi-555-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn socket_dir_takes_the_first_absolute_candidate() {
        let dir = socket_dir(
            &[None, Some("rel".into()), Some("/var/folders/ab/T/".into())],
            "com.nauvi.app",
        );
        assert_eq!(
            dir,
            Some(PathBuf::from("/var/folders/ab/T/com.nauvi.app.si"))
        );
        let dir = socket_dir(&[Some("/a".into()), Some("/b".into())], "x/y");
        assert_eq!(dir, Some(PathBuf::from("/a/x_y.si")));
        assert_eq!(
            socket_dir(&[None, Some("/".into()), Some("".into())], "x"),
            None
        );
    }

    #[test]
    fn private_dir_is_created_0700_and_checked() {
        let base = scratch("dir");
        let uid = current_uid();
        let dir = base.join("app.si");
        private_dir(&dir, uid).unwrap();
        let meta = std::fs::symlink_metadata(&dir).unwrap();
        assert_eq!(meta.mode() & 0o077, 0);
        // Already there and private: fine.
        private_dir(&dir, uid).unwrap();
        // Open to others: refused, never loosened or fixed.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_dir(&dir, uid)
            .unwrap_err()
            .contains("open to other users"));
        // Someone else's: refused.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let meta = std::fs::symlink_metadata(&dir).unwrap();
        assert!(check_dir(&meta, uid + 1)
            .unwrap_err()
            .contains("belongs to another user"));
        // A symlink to a private directory: refused.
        let link = base.join("link.si");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(private_dir(&link, uid)
            .unwrap_err()
            .contains("not a directory"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_this_users_socket_is_used() {
        let base = scratch("sock");
        let uid = current_uid();
        let dir = base.join("app.si");
        private_dir(&dir, uid).unwrap();
        let socket = dir.join("sock");
        // A plain file where the socket goes: nothing is sent, nothing removed.
        std::fs::write(&socket, b"").unwrap();
        match start(&dir, uid, b"x") {
            Start::Alone(why) => assert!(why.contains("not a socket"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(socket.exists());
        std::fs::remove_file(&socket).unwrap();
        // Another user's socket.
        let _listener = UnixListener::bind(&socket).unwrap();
        let meta = std::fs::symlink_metadata(&socket).unwrap();
        assert!(check_socket(&meta, uid).is_ok());
        assert!(check_socket(&meta, uid + 1)
            .unwrap_err()
            .contains("belongs to another user"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hand_over_reaches_the_first_copy() {
        let base = scratch("hand");
        let uid = current_uid();
        let dir = base.join("app.si");
        let Start::First(listener) = start(&dir, uid, b"") else {
            panic!("the first launch claims the socket");
        };
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            receive(stream, uid)
        });
        let args = vec!["nauvi".to_string(), "nauvi://open?x=1".to_string()];
        assert!(matches!(
            start(&dir, uid, &encode("/home/a", &args)),
            Start::HandedOver
        ));
        assert_eq!(server.join().unwrap(), Some(("/home/a".to_string(), args)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_stale_socket_is_replaced() {
        let base = scratch("stale");
        let uid = current_uid();
        let dir = base.join("app.si");
        private_dir(&dir, uid).unwrap();
        // Bound, then closed: what a crashed copy leaves.
        drop(UnixListener::bind(dir.join("sock")).unwrap());
        assert!(matches!(start(&dir, uid, b""), Start::First(_)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_long_path_is_refused() {
        let base = scratch("long");
        let dir = base.join(format!("{}.si", "a".repeat(120)));
        match start(&dir, current_uid(), b"") {
            Start::Alone(why) => assert!(why.contains("too long"), "{why}"),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn decode_reads_encode() {
        let args = vec!["a".to_string(), "b c".to_string()];
        assert_eq!(
            decode(&String::from_utf8(encode("/w", &args)).unwrap()),
            ("/w".into(), args)
        );
        assert_eq!(decode("junk"), (String::new(), vec![String::new()]));
    }
}
