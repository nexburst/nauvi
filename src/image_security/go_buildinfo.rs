//! The build information a Go binary carries (#536): its main module and
//! version, read from the file's bytes without running it.
//!
//! Trivy 0.69.4 to 0.69.6 ran their malicious code whenever the binary ran,
//! even for `trivy version`, so nauvi must know the version before it runs
//! anything. Go (1.18 and later) writes a block that starts with
//! [`MAGIC`] at a 16-byte boundary: a 32-byte header, then two strings,
//! each prefixed by its length as a uvarint: the Go version (`go1.24.1`)
//! and the module info, lines like
//!
//! ```text
//! path    github.com/aquasecurity/trivy/cmd/trivy
//! mod     github.com/aquasecurity/trivy   v0.69.5   h1:…
//! build   -ldflags="-s -w -X github.com/aquasecurity/trivy/pkg/version/app.ver=0.69.5"
//! ```
//!
//! [`Finder`] looks for it in the chunks the SHA-256 pass reads anyway (no
//! second read of the file) and keeps at most [`MAX_BLOCK`] bytes after a
//! candidate. The same string can also sit in the binary's read-only data
//! (a program that reads build info, like Trivy itself): a candidate whose
//! header or strings do not parse is skipped.

/// The start of the block.
pub const MAGIC: &[u8; 14] = b"\xff Go buildinf:";
/// The header before the strings.
const HEADER: usize = 32;
/// The block is aligned to this in the file.
const ALIGN: u64 = 16;
/// The most read after a candidate: the header and both strings.
pub const MAX_BLOCK: usize = 64 * 1024;
/// Go 1.18+: the strings follow the header (older ones point elsewhere).
const FLAG_INLINE: u8 = 2;
/// The markers around the module info (16 bytes each).
const SENTINEL: usize = 16;
/// The longest Go version taken (`go1.25.7 X:jsonv2,boringcrypto`).
const MAX_GO_VERSION: usize = 256;

/// What the block says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildInfo {
    /// `go1.24.1`.
    pub go_version: String,
    /// The `path` line: the main package (`…/cmd/trivy`).
    pub path: String,
    /// The `mod` line: the main module and its version (`v0.69.5`,
    /// `(devel)` when Go did not stamp one).
    pub main_module: String,
    pub main_version: String,
    /// The `-X name=value` settings of the `-ldflags` build line.
    pub ldflags_x: Vec<(String, String)>,
}

impl BuildInfo {
    /// The value of `-X <name>=` (the last one, as the linker takes it).
    pub fn x(&self, name: &str) -> Option<&str> {
        self.ldflags_x
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// An unsigned LEB128 varint at the start of `b`: (value, bytes used).
fn uvarint(b: &[u8]) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    for (i, &byte) in b.iter().enumerate().take(10) {
        v |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some((v, i + 1));
        }
    }
    None
}

/// A length-prefixed string at the start of `b`, and the rest.
fn string(b: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, used) = uvarint(b)?;
    let len = usize::try_from(len).ok()?;
    let body = b.get(used..used.checked_add(len)?)?;
    Some((body, &b[used + len..]))
}

/// The block at the start of `b` (which starts with [`MAGIC`]), `None` when
/// it is not one (or an old one without inline strings).
pub fn parse_block(b: &[u8]) -> Option<BuildInfo> {
    if !b.starts_with(MAGIC) || b.len() < HEADER {
        return None;
    }
    let ptr_size = b[14];
    let flags = b[15];
    if !matches!(ptr_size, 4 | 8) || flags & FLAG_INLINE == 0 {
        return None;
    }
    let (go_version, rest) = string(&b[HEADER..])?;
    // Checked on the bytes first: a crafted candidate with a long "version"
    // costs no UTF-8 pass over it (#561).
    if go_version.len() > MAX_GO_VERSION || !go_version.starts_with(b"go") {
        return None;
    }
    let go_version = std::str::from_utf8(go_version).ok()?;
    let (mut modinfo, _) = string(rest)?;
    // Go puts 16 bytes (not text) before and after it.
    if modinfo.len() > 2 * SENTINEL && modinfo[modinfo.len() - SENTINEL - 1] == b'\n' {
        modinfo = &modinfo[SENTINEL..modinfo.len() - SENTINEL];
    }
    let modinfo = String::from_utf8_lossy(modinfo);
    let mut info = BuildInfo {
        go_version: go_version.to_string(),
        ..BuildInfo::default()
    };
    for line in modinfo.lines() {
        let mut parts = line.split('\t');
        match parts.next() {
            Some("path") => info.path = parts.next().unwrap_or_default().to_string(),
            Some("mod") => {
                info.main_module = parts.next().unwrap_or_default().to_string();
                info.main_version = parts.next().unwrap_or_default().to_string();
            }
            Some("build") => {
                let setting = parts.collect::<Vec<_>>().join("\t");
                if let Some(flags) = setting.strip_prefix("-ldflags=") {
                    info.ldflags_x.extend(x_flags(flags));
                }
            }
            _ => {}
        }
    }
    Some(info)
}

/// The `-X name=value` pairs of an `-ldflags` value (Go quotes it when it
/// has spaces). Both `-X name=value` and `-X=name=value`.
fn x_flags(flags: &str) -> Vec<(String, String)> {
    let flags = flags
        .strip_prefix('"')
        .and_then(|f| f.strip_suffix('"'))
        .unwrap_or(flags);
    let words: Vec<&str> = flags
        .split_whitespace()
        .map(|w| w.trim_matches(|c| c == '\'' || c == '"'))
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let pair = match words[i] {
            "-X" | "--X" => {
                i += 1;
                words.get(i).copied()
            }
            w => w.strip_prefix("-X=").or_else(|| w.strip_prefix("--X=")),
        };
        if let Some((name, value)) = pair.and_then(|p| p.split_once('=')) {
            out.push((name.to_string(), value.to_string()));
        }
        i += 1;
    }
    out
}

/// Looks for the block in a file read in chunks, in order.
#[derive(Debug, Default)]
pub struct Finder {
    /// Bytes not looked at yet, from file offset `base`.
    buf: Vec<u8>,
    base: u64,
    found: Option<BuildInfo>,
}

impl Finder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next bytes of the file.
    pub fn feed(&mut self, chunk: &[u8]) {
        if self.found.is_some() {
            return;
        }
        self.buf.extend_from_slice(chunk);
        self.search(false);
    }

    /// The end of the file: what was found, if anything.
    pub fn finish(mut self) -> Option<BuildInfo> {
        if self.found.is_none() {
            self.search(true);
        }
        self.found
    }

    fn search(&mut self, eof: bool) {
        // The first aligned offset in `buf`.
        let mut i = ((ALIGN - self.base % ALIGN) % ALIGN) as usize;
        while i + MAGIC.len() <= self.buf.len() {
            if &self.buf[i..i + MAGIC.len()] == MAGIC {
                let end = (i + MAX_BLOCK).min(self.buf.len());
                if end - i < MAX_BLOCK && !eof {
                    // Wait for the rest of the block.
                    break;
                }
                if let Some(info) = parse_block(&self.buf[i..end]) {
                    self.found = Some(info);
                    self.buf = Vec::new();
                    return;
                }
            }
            i += ALIGN as usize;
        }
        // Keep from `i` on: a candidate waiting for its block, or the
        // bytes a magic split across two chunks may start in.
        let keep = i.min(self.buf.len());
        self.buf.drain(..keep);
        self.base += keep as u64;
    }
}

/// [`Finder`] over bytes already in memory.
pub fn find(data: &[u8]) -> Option<BuildInfo> {
    let mut f = Finder::new();
    f.feed(data);
    f.finish()
}

/// Blocks as Go writes them, for tests here and in `local`.
#[cfg(test)]
pub(crate) mod fixture {
    use super::*;

    pub(crate) fn put_uvarint(out: &mut Vec<u8>, mut v: u64) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// A block as Go 1.18+ writes it.
    pub(crate) fn block(go: &str, modinfo: &str) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.push(8);
        b.push(FLAG_INLINE);
        b.resize(HEADER, 0);
        put_uvarint(&mut b, go.len() as u64);
        b.extend_from_slice(go.as_bytes());
        // Go's markers (`runtime/debug`'s modinfo), not UTF-8.
        let mut m = hex("3077af0c9274080241e1c107e6d618e6");
        m.extend_from_slice(modinfo.as_bytes());
        m.extend_from_slice(&hex("f932433186182072008242104116d8f2"));
        put_uvarint(&mut b, m.len() as u64);
        b.extend_from_slice(&m);
        b
    }

    /// The module info of a Trivy 0.69.5 release build.
    pub(crate) const TRIVY: &str = "path\tgithub.com/aquasecurity/trivy/cmd/trivy\n\
        mod\tgithub.com/aquasecurity/trivy\tv0.69.5\th1:abc=\n\
        dep\tgithub.com/spf13/cobra\tv1.8.0\th1:def=\n\
        build\t-ldflags=\"-s -w -X github.com/aquasecurity/trivy/pkg/version/app.ver=0.69.5\"\n\
        build\tGOOS=linux\n";
}

#[cfg(test)]
mod tests {
    use super::fixture::{self, block, TRIVY};
    use super::*;

    /// `filler` bytes, then the block at an aligned offset, then more.
    fn binary(filler: usize, b: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; filler];
        // A stray copy of the magic in "read-only data", unaligned and
        // aligned, before the real one.
        out.extend_from_slice(b"\x01\x02\x03");
        out.extend_from_slice(MAGIC);
        out.resize(out.len().div_ceil(16) * 16, 0);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&[0u8; 2]);
        out.resize(out.len().div_ceil(16) * 16, 0);
        out.extend_from_slice(b);
        out.extend_from_slice(&[7u8; 1000]);
        out
    }

    #[test]
    fn reads_the_main_module_and_ldflags() {
        let info = find(&binary(100, &block("go1.24.1", TRIVY))).unwrap();
        assert_eq!(info.go_version, "go1.24.1");
        assert_eq!(info.path, "github.com/aquasecurity/trivy/cmd/trivy");
        assert_eq!(info.main_module, "github.com/aquasecurity/trivy");
        assert_eq!(info.main_version, "v0.69.5");
        assert_eq!(
            info.x("github.com/aquasecurity/trivy/pkg/version/app.ver"),
            Some("0.69.5")
        );
    }

    #[test]
    fn finds_it_across_chunks_of_any_size() {
        let data = binary(300_000, &block("go1.25.0", TRIVY));
        for size in [1, 7, 13, 16, 4096, 256 * 1024] {
            let mut f = Finder::new();
            for c in data.chunks(size) {
                f.feed(c);
            }
            let info = f.finish().unwrap_or_else(|| panic!("chunk size {size}"));
            assert_eq!(info.main_version, "v0.69.5", "chunk size {size}");
        }
    }

    #[test]
    fn keeps_little_while_it_looks() {
        let mut f = Finder::new();
        for _ in 0..64 {
            f.feed(&[0u8; 256 * 1024]);
            assert!(f.buf.len() < 32, "{}", f.buf.len());
        }
        assert!(f.finish().is_none());
    }

    #[test]
    fn a_block_at_the_end_of_the_file() {
        let mut data = vec![0u8; 32];
        data.extend_from_slice(&block("go1.22.0", TRIVY));
        assert_eq!(find(&data).unwrap().main_version, "v0.69.5");
    }

    #[test]
    fn not_a_block() {
        assert!(find(b"").is_none());
        assert!(find(&[0u8; 10_000]).is_none());
        // Unaligned: not the block.
        let mut data = vec![0u8; 3];
        data.extend_from_slice(&block("go1.22.0", TRIVY));
        assert!(find(&data).is_none());
        // Old (pointers, not inline strings).
        let mut old = block("go1.17", TRIVY);
        old[15] = 0;
        assert!(find(&old).is_none());
        // A length past the end.
        let mut cut = MAGIC.to_vec();
        cut.extend_from_slice(&[8, FLAG_INLINE]);
        cut.resize(HEADER, 0);
        cut.extend_from_slice(&[0xff, 0xff, 0x03]);
        assert!(find(&cut).is_none());
        // Not a Go version.
        assert!(find(&block("hello", TRIVY)).is_none());
        assert!(find(&block(&"go1".repeat(200), TRIVY)).is_none());
    }

    /// A candidate with the header of a block and a long string where the
    /// Go version goes, `go…` or not.
    fn candidate(version: &[u8]) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(&[8, FLAG_INLINE]);
        b.resize(HEADER, 0);
        fixture::put_uvarint(&mut b, version.len() as u64);
        b.extend_from_slice(version);
        b.extend_from_slice(&[0u8; 8]);
        b
    }

    /// The `go` prefix and the length are checked on the bytes, before the
    /// string is decoded (#561); a crafted file with candidates every 16
    /// bytes is still read, and its real block found.
    #[test]
    fn crafted_candidates_are_dropped_early() {
        assert!(parse_block(&candidate(&[b'x'; 60_000])).is_none());
        let mut long = b"go".to_vec();
        long.resize(60_000, b'1');
        assert!(parse_block(&candidate(&long)).is_none());
        assert!(parse_block(&candidate(b"go\xff1.24")).is_none());

        let mut data = Vec::new();
        while data.len() < 1024 * 1024 {
            data.extend_from_slice(MAGIC);
            data.extend_from_slice(&[8, FLAG_INLINE]);
        }
        data.extend_from_slice(&block("go1.24.1", TRIVY));
        data.extend_from_slice(&[0u8; 1024]);
        assert_eq!(find(&data).unwrap().main_version, "v0.69.5");
    }

    #[test]
    fn a_devel_build_without_ldflags() {
        let info = find(&block(
            "go1.24.0",
            "path\tgithub.com/aquasecurity/trivy/cmd/trivy\nmod\tgithub.com/aquasecurity/trivy\t(devel)\t\n",
        ))
        .unwrap();
        assert_eq!(info.main_version, "(devel)");
        assert!(info.ldflags_x.is_empty());
    }

    #[test]
    fn ldflags_forms() {
        assert_eq!(
            x_flags("\"-s -w -X=a.b=1 -X 'c.d=2' -X e.f=3\""),
            vec![
                ("a.b".to_string(), "1".to_string()),
                ("c.d".to_string(), "2".to_string()),
                ("e.f".to_string(), "3".to_string()),
            ]
        );
        assert!(x_flags("-s -w -X").is_empty());
    }

    #[test]
    fn uvarints() {
        assert_eq!(uvarint(&[0x05]), Some((5, 1)));
        assert_eq!(uvarint(&[0x80, 0x01]), Some((128, 2)));
        assert_eq!(uvarint(&[0x80]), None);
    }
}
