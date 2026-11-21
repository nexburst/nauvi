//! The part of SPDY/3.1 a port-forward session needs (#399).
//!
//! kubectl keeps one SPDY connection to the kubelet per forward (directly,
//! or tunnelled in a WebSocket since Kubernetes 1.31) and opens a pair of
//! streams on it per local connection: `streamType: error` and
//! `streamType: data`, with the same `port` and `requestID`. The kubelet
//! dials the pod's port only when both streams of a request arrive, so an
//! open session with no streams does not touch the pod.
//!
//! The kubelet's side is moby/spdystream, which shapes what is here:
//!
//! - It has no flow control, and a WINDOW_UPDATE is an "unhandled frame
//!   type" for it, so none is ever sent.
//! - Header blocks are zlib streams. Go's zlib reader accepts one without a
//!   preset dictionary, so ours are stored (uncompressed) deflate blocks:
//!   no dictionary, no compressor. The server's header blocks (SYN_REPLY)
//!   carry nothing a port-forward uses, so they are never decompressed.

use bytes::{BufMut, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt};

const VERSION: u16 = 3;

pub(crate) const SYN_STREAM: u16 = 1;
pub(crate) const SYN_REPLY: u16 = 2;
pub(crate) const RST_STREAM: u16 = 3;
pub(crate) const PING: u16 = 6;
pub(crate) const GOAWAY: u16 = 7;
pub(crate) const HEADERS: u16 = 8;

pub(crate) const FLAG_FIN: u8 = 0x01;

/// RST_STREAM status: CANCEL.
pub(crate) const CANCEL: u32 = 5;

/// The largest frame accepted. The kubelet writes at most 32 KiB at a
/// time; the 24-bit length field would allow 16 MiB, and each stream
/// queues up to 32 frames.
pub(crate) const MAX_LENGTH: usize = 1024 * 1024;

/// A frame from the server, with only what a port-forward uses.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Frame {
    Data {
        stream: u32,
        fin: bool,
        data: Bytes,
    },
    /// SYN_REPLY or HEADERS: the stream was accepted (`fin`: and closed).
    Reply {
        stream: u32,
        fin: bool,
    },
    Reset {
        stream: u32,
        status: u32,
    },
    Ping {
        id: u32,
    },
    GoAway,
    /// SETTINGS, WINDOW_UPDATE, a SYN_STREAM from the server, ...: ignored.
    Other,
}

/// Read one frame.
pub(crate) async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Frame> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head).await?;
    let flags = head[4];
    let len = u32::from_be_bytes([0, head[5], head[6], head[7]]) as usize;
    if len > MAX_LENGTH {
        return Err(invalid("frame too long"));
    }
    let mut body = BytesMut::zeroed(len);
    r.read_exact(&mut body).await?;
    let body = body.freeze();
    let fin = flags & FLAG_FIN != 0;
    if head[0] & 0x80 == 0 {
        let stream = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) & 0x7fff_ffff;
        return Ok(Frame::Data {
            stream,
            fin,
            data: body,
        });
    }
    let version = u16::from_be_bytes([head[0], head[1]]) & 0x7fff;
    if version != VERSION {
        return Err(invalid("not SPDY/3"));
    }
    let word = |i: usize| -> std::io::Result<u32> {
        body.get(i..i + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| invalid("control frame too short"))
    };
    Ok(match u16::from_be_bytes([head[2], head[3]]) {
        SYN_REPLY | HEADERS => Frame::Reply {
            stream: word(0)? & 0x7fff_ffff,
            fin,
        },
        RST_STREAM => Frame::Reset {
            stream: word(0)? & 0x7fff_ffff,
            status: word(4)?,
        },
        PING => Frame::Ping { id: word(0)? },
        GOAWAY => Frame::GoAway,
        _ => Frame::Other,
    })
}

fn invalid(what: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, format!("SPDY: {what}"))
}

fn control(kind: u16, flags: u8, body: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + body.len());
    f.put_u16(0x8000 | VERSION);
    f.put_u16(kind);
    f.put_u32((u32::from(flags) << 24) | body.len() as u32);
    f.extend_from_slice(body);
    f
}

/// A DATA frame. `data` must be shorter than 16 MiB.
pub(crate) fn data(stream: u32, data: &[u8], fin: bool) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + data.len());
    f.put_u32(stream & 0x7fff_ffff);
    f.put_u32((u32::from(if fin { FLAG_FIN } else { 0 }) << 24) | data.len() as u32);
    f.extend_from_slice(data);
    f
}

pub(crate) fn rst_stream(stream: u32, status: u32) -> Vec<u8> {
    let mut body = Vec::with_capacity(8);
    body.put_u32(stream & 0x7fff_ffff);
    body.put_u32(status);
    control(RST_STREAM, 0, &body)
}

pub(crate) fn ping(id: u32) -> Vec<u8> {
    control(PING, 0, &id.to_be_bytes())
}

/// The header blocks of one connection: one zlib stream across all of its
/// frames, made of stored deflate blocks.
#[derive(Default)]
pub(crate) struct Headers {
    started: bool,
}

impl Headers {
    /// A SYN_STREAM for `stream` with `headers` (names in lowercase).
    pub(crate) fn syn_stream(&mut self, stream: u32, headers: &[(&str, &str)]) -> Vec<u8> {
        let mut block = Vec::new();
        block.put_u32(headers.len() as u32);
        for (name, value) in headers {
            block.put_u32(name.len() as u32);
            block.extend_from_slice(name.as_bytes());
            block.put_u32(value.len() as u32);
            block.extend_from_slice(value.as_bytes());
        }
        let mut body = Vec::with_capacity(16 + block.len());
        body.put_u32(stream & 0x7fff_ffff);
        // Associated-to stream, priority and slot: none.
        body.put_u32(0);
        body.put_u16(0);
        if !self.started {
            // zlib header: deflate, 32 KiB window, no dictionary.
            body.extend_from_slice(&[0x78, 0x01]);
            self.started = true;
        }
        // Stored blocks hold at most 65535 bytes; header blocks are tiny.
        for chunk in block.chunks(0xffff) {
            // BFINAL 0, BTYPE 00 (stored), padded to the byte.
            body.push(0);
            body.put_u16_le(chunk.len() as u16);
            body.put_u16_le(!(chunk.len() as u16));
            body.extend_from_slice(chunk);
        }
        // An empty stored block, as Go's sync flush ends each block with.
        // Go's reader needs it: without it, the next frame's header block
        // fails with "compressed payload size was incorrect".
        body.extend_from_slice(&[0, 0, 0, 0xff, 0xff]);
        control(SYN_STREAM, 0, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(bytes: Vec<u8>) -> Frame {
        read_frame(&mut &bytes[..]).await.unwrap()
    }

    #[tokio::test]
    async fn data_frames_round_trip() {
        let f = data(7, b"hello", true);
        assert_eq!(&f[..8], &[0, 0, 0, 7, 1, 0, 0, 5]);
        assert_eq!(
            parse(f).await,
            Frame::Data {
                stream: 7,
                fin: true,
                data: Bytes::from_static(b"hello")
            }
        );
    }

    #[tokio::test]
    async fn control_frames_parse() {
        assert_eq!(parse(ping(3)).await, Frame::Ping { id: 3 });
        assert_eq!(
            parse(rst_stream(5, CANCEL)).await,
            Frame::Reset {
                stream: 5,
                status: CANCEL
            }
        );
        // A SYN_REPLY with FIN and a (compressed, unread) header block.
        let reply = control(SYN_REPLY, FLAG_FIN, &[0, 0, 0, 9, 0x78, 0xbb, 1, 2]);
        assert_eq!(
            parse(reply).await,
            Frame::Reply {
                stream: 9,
                fin: true
            }
        );
        // WINDOW_UPDATE and SETTINGS are ignored.
        assert_eq!(parse(control(9, 0, &[0; 8])).await, Frame::Other);
        assert_eq!(parse(control(4, 0, &[0; 4])).await, Frame::Other);
    }

    #[tokio::test]
    async fn a_frame_over_1_mib_is_an_error() {
        let f = data(1, &vec![0u8; MAX_LENGTH + 1], false);
        assert!(read_frame(&mut &f[..]).await.is_err());
        let f = data(1, &vec![0u8; MAX_LENGTH], false);
        assert!(read_frame(&mut &f[..]).await.is_ok());
    }

    #[tokio::test]
    async fn a_short_control_frame_is_an_error() {
        let f = control(RST_STREAM, 0, &[0, 0]);
        assert!(read_frame(&mut &f[..]).await.is_err());
    }

    /// The header blocks of consecutive SYN_STREAMs form one valid zlib
    /// stream, as the kubelet's reader keeps one across frames.
    #[test]
    fn header_blocks_are_one_zlib_stream() {
        use std::io::Read;
        let mut h = Headers::default();
        let first = h.syn_stream(1, &[("streamtype", "error"), ("port", "80")]);
        let second = h.syn_stream(3, &[("streamtype", "data")]);
        assert_eq!(&first[..4], &[0x80, 3, 0, 1]);
        assert_eq!(&first[8..12], &[0, 0, 0, 1]);
        let mut zlib = Vec::new();
        zlib.extend_from_slice(&first[18..]);
        zlib.extend_from_slice(&second[18..]);
        // Zlib header check bits.
        assert_eq!(u16::from_be_bytes([zlib[0], zlib[1]]) % 31, 0);
        // Inflate the raw deflate part (after the 2-byte zlib header).
        let mut out = Vec::new();
        let _ = flate2::read::DeflateDecoder::new(&zlib[2..]).read_to_end(&mut out);
        let mut want = Vec::new();
        want.put_u32(2);
        for s in ["streamtype", "error", "port", "80"] {
            want.put_u32(s.len() as u32);
            want.extend_from_slice(s.as_bytes());
        }
        want.put_u32(1);
        for s in ["streamtype", "data"] {
            want.put_u32(s.len() as u32);
            want.extend_from_slice(s.as_bytes());
        }
        assert_eq!(out, want);
    }
}
