//! Where a terminal session writes (#115): its output goes to the tab's
//! channel in batches, with flow control and bounded memory.
//!
//! - **Batches.** A pod's output arrives in pieces of at most 1 KiB (kube's
//!   pipe) and a PTY's in a few KiB; each channel message costs an IPC
//!   round trip in the webview. Pieces that follow each other within
//!   `BATCH_GAP` go out together (up to `BATCH_WAIT` and `BATCH_MAX`); a
//!   lone echo waits at most `BATCH_GAP`.
//! - **Credit.** At most `WINDOW` bytes are on their way to the tab: it
//!   acknowledges what it has written into xterm (`cmd_exec_ack`,
//!   `cmd_local_shell_ack`). A channel send never blocks, so without this a
//!   flood (`yes`) would pile up in the webview.
//! - **Bounded.** What waits for credit is kept up to `QUEUE_MAX`; past it
//!   the oldest output is dropped (never blocking the reader, which would
//!   stall the remote process too) and the tab gets one notice saying how
//!   much was skipped. Ctrl-C drops what waits ([`TermOut::clear`]), so the
//!   prompt shows at once instead of after the backlog.
//!
//! Events (`closed`) are never dropped and go out after the output before
//! them.

use super::term_frame::{TermChannel, TermEvent, TermFrame};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

/// How long a batch waits for more output after the last piece.
const BATCH_GAP: Duration = Duration::from_millis(1);
/// How long a batch waits in all after its first piece.
const BATCH_WAIT: Duration = Duration::from_millis(8);
/// The most a batch holds.
const BATCH_MAX: usize = 256 * 1024;
/// The most bytes sent to the tab and not acknowledged yet.
const WINDOW: usize = 8 * 1024 * 1024;
/// The most output kept while waiting for credit.
const QUEUE_MAX: usize = 8 * 1024 * 1024;

enum Msg {
    Frame(TermFrame),
    Ack(usize),
    Clear,
}

/// A terminal session's output, see the module docs. Cheap to clone; the
/// batching task ends when every clone is gone.
#[derive(Clone)]
pub(crate) struct TermOut(UnboundedSender<Msg>);

impl TermOut {
    pub(crate) fn new(ch: TermChannel) -> Self {
        let (tx, rx) = unbounded_channel();
        tauri::async_runtime::spawn(run(rx, move |f| {
            // A closed tab has nobody left to read it (its session is
            // closed by the tab or with its window).
            let _ = ch.send(f);
        }));
        TermOut(tx)
    }

    /// One that goes nowhere (tests).
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        TermOut(unbounded_channel().0)
    }

    /// The tab wrote (or dropped) `bytes` of what it got.
    pub(crate) fn ack(&self, bytes: usize) {
        let _ = self.0.send(Msg::Ack(bytes));
    }

    /// Drop the output not sent yet (Ctrl-C), with a notice.
    pub(crate) fn clear(&self) {
        let _ = self.0.send(Msg::Clear);
    }
}

/// Send `bytes` to the screen (nothing for none).
pub(crate) fn send_data(out: &TermOut, bytes: Vec<u8>) {
    if !bytes.is_empty() {
        let _ = out.0.send(Msg::Frame(TermFrame::Data(bytes)));
    }
}

/// Tell the tab its session ended (after the output sent before).
pub(crate) fn send_closed(out: &TermOut) {
    let _ = out.0.send(Msg::Frame(TermFrame::Event(TermEvent::Closed)));
}

/// "[… 12.3 MB of output skipped]" as a line of its own.
pub(crate) fn skipped_notice(bytes: usize) -> Vec<u8> {
    let size = if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    };
    format!("\r\n\x1b[0m\x1b[90m[… {size} of output skipped]\x1b[0m\r\n").into_bytes()
}

/// What waits for credit.
#[derive(Default)]
struct Pending {
    frames: VecDeque<TermFrame>,
    /// Bytes of output in `frames`.
    bytes: usize,
    /// Bytes dropped since the last batch went out.
    skipped: usize,
}

impl Pending {
    fn push(&mut self, f: TermFrame) {
        if let TermFrame::Data(b) = &f {
            self.bytes += b.len();
        }
        self.frames.push_back(f);
        while self.bytes > QUEUE_MAX {
            let Some(i) = self
                .frames
                .iter()
                .position(|f| matches!(f, TermFrame::Data(_)))
            else {
                break;
            };
            if let Some(TermFrame::Data(b)) = self.frames.remove(i) {
                self.bytes -= b.len();
                self.skipped += b.len();
            }
        }
    }

    fn clear(&mut self) {
        self.skipped += self.bytes;
        self.bytes = 0;
        self.frames.retain(|f| matches!(f, TermFrame::Event(_)));
        self.frames.push_back(TermFrame::Event(TermEvent::Cleared));
    }

    fn front_is_data(&self) -> bool {
        matches!(self.frames.front(), Some(TermFrame::Data(_)))
    }

    /// The leading output, whole pieces up to `BATCH_MAX` (at least one),
    /// after a notice of what was skipped.
    fn take_batch(&mut self) -> Vec<u8> {
        let mut out = if self.skipped > 0 {
            skipped_notice(std::mem::take(&mut self.skipped))
        } else {
            Vec::new()
        };
        let mut taken = 0;
        while let Some(TermFrame::Data(b)) = self.frames.front() {
            if taken > 0 && taken + b.len() > BATCH_MAX {
                break;
            }
            taken += b.len();
            if let Some(TermFrame::Data(b)) = self.frames.pop_front() {
                out.extend_from_slice(&b);
            }
        }
        self.bytes -= taken;
        out
    }
}

fn handle(m: Msg, q: &mut Pending, in_flight: &mut usize) {
    match m {
        Msg::Frame(f) => q.push(f),
        Msg::Ack(n) => *in_flight = in_flight.saturating_sub(n),
        Msg::Clear => q.clear(),
    }
}

/// Move the output and events of `rx` to `sink` (see the module docs).
async fn run(mut rx: UnboundedReceiver<Msg>, sink: impl Fn(TermFrame)) {
    let mut q = Pending::default();
    let mut in_flight = 0usize;
    let mut open = true;
    loop {
        // Top up a batch while more output follows closely.
        if open && in_flight < WINDOW && q.front_is_data() && q.bytes < BATCH_MAX {
            let deadline = Instant::now() + BATCH_WAIT;
            loop {
                let until = deadline.min(Instant::now() + BATCH_GAP);
                match tokio::time::timeout_at(until, rx.recv()).await {
                    Ok(Some(m)) => {
                        handle(m, &mut q, &mut in_flight);
                        if q.bytes >= BATCH_MAX || !q.front_is_data() {
                            break;
                        }
                    }
                    Ok(None) => {
                        open = false;
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
        // Send what the credit allows (all of it once nobody can ack).
        loop {
            match q.frames.front() {
                None if q.skipped > 0 && (!open || in_flight < WINDOW) => {
                    let notice = q.take_batch();
                    in_flight += notice.len();
                    sink(TermFrame::Data(notice));
                }
                None => break,
                Some(TermFrame::Event(_)) => {
                    if let Some(e) = q.frames.pop_front() {
                        sink(e);
                    }
                }
                Some(TermFrame::Data(_)) => {
                    if open && in_flight >= WINDOW {
                        break;
                    }
                    let batch = q.take_batch();
                    in_flight += batch.len();
                    sink(TermFrame::Data(batch));
                }
            }
        }
        if !open {
            return;
        }
        match rx.recv().await {
            Some(m) => handle(m, &mut q, &mut in_flight),
            None => open = false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A running `run` and what it handed on: data as text, events as "<closed>".
    struct Harness {
        out: TermOut,
        got: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    fn harness() -> Harness {
        let (tx, rx) = unbounded_channel();
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink_got = got.clone();
        let task = tokio::spawn(run(rx, move |f| {
            sink_got.lock().unwrap().push(match f {
                TermFrame::Data(b) => String::from_utf8_lossy(&b).into_owned(),
                TermFrame::Event(TermEvent::Closed) => "<closed>".into(),
                TermFrame::Event(TermEvent::Cleared) => "<cleared>".into(),
            });
        }));
        Harness {
            out: TermOut(tx),
            got,
            task,
        }
    }

    impl Harness {
        fn sent(&self) -> Vec<String> {
            self.got.lock().unwrap().clone()
        }
        async fn settle(&self) {
            tokio::time::sleep(BATCH_WAIT * 2).await;
        }
        async fn finish(self) -> Vec<String> {
            drop(self.out);
            self.task.await.unwrap();
            let out = self.got.lock().unwrap().clone();
            out
        }
    }

    async fn batched(pieces: &[&str], gap: Option<Duration>) -> Vec<String> {
        let h = harness();
        for p in pieces {
            send_data(&h.out, p.as_bytes().to_vec());
            if let Some(gap) = gap {
                tokio::time::sleep(gap).await;
            }
        }
        h.finish().await
    }

    #[tokio::test(start_paused = true)]
    async fn pieces_in_a_row_go_out_together_and_events_after_them() {
        let h = harness();
        for p in ["a", "b", "c"] {
            send_data(&h.out, p.into());
        }
        send_closed(&h.out);
        h.settle().await;
        assert_eq!(h.sent(), ["abc", "<closed>"]);
    }

    #[tokio::test(start_paused = true)]
    async fn pieces_further_apart_than_the_gap_go_out_alone() {
        assert_eq!(batched(&["a", "b"], Some(BATCH_GAP * 3)).await, ["a", "b"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_batch_ends_at_its_size_and_time_limits() {
        let big = "x".repeat(BATCH_MAX);
        assert_eq!(batched(&[&big, "y"], None).await, [big, "y".into()]);
        // A steady trickle, each piece within the gap: cut after BATCH_WAIT.
        let out = batched(&["z"; 20], Some(BATCH_GAP / 2)).await;
        assert!(out.len() > 1, "{out:?}");
        assert_eq!(out.concat(), "z".repeat(20));
    }

    #[tokio::test(start_paused = true)]
    async fn no_more_than_the_window_goes_out_before_an_ack() {
        let h = harness();
        let piece = "p".repeat(64 * 1024);
        for _ in 0..(WINDOW / piece.len()) * 2 {
            send_data(&h.out, piece.clone().into_bytes());
        }
        h.settle().await;
        let sent: usize = h.sent().iter().map(String::len).sum();
        assert_eq!(sent, WINDOW);
        h.out.ack(WINDOW);
        h.settle().await;
        let sent: usize = h.sent().iter().map(String::len).sum();
        assert_eq!(sent, 2 * WINDOW);
    }

    #[tokio::test(start_paused = true)]
    async fn past_the_queue_bound_the_oldest_output_is_skipped_with_a_notice() {
        let h = harness();
        let piece = "q".repeat(1024 * 1024);
        // The window, then 8 MB queued, then 3 MB more, then LAST: the
        // oldest 4 MB waiting are dropped.
        for _ in 0..(WINDOW + QUEUE_MAX) / piece.len() + 3 {
            send_data(&h.out, piece.clone().into_bytes());
        }
        send_data(&h.out, b"LAST".to_vec());
        send_closed(&h.out);
        h.settle().await;
        h.out.ack(WINDOW);
        let got = h.finish().await;
        let all = got.concat();
        assert!(
            all.contains("[… 4.0 MB of output skipped]"),
            "{}",
            &all[..200.min(all.len())]
        );
        assert!(all.ends_with("LAST<closed>"));
        let kept = all.matches('q').count();
        assert_eq!(kept, WINDOW + QUEUE_MAX - piece.len());
    }

    #[tokio::test(start_paused = true)]
    async fn clear_drops_what_waits_and_keeps_events() {
        let h = harness();
        let piece = "c".repeat(1024 * 1024);
        for _ in 0..WINDOW / piece.len() + 2 {
            send_data(&h.out, piece.clone().into_bytes());
        }
        h.settle().await;
        h.out.clear();
        send_data(&h.out, b"^C\r\n$ ".to_vec());
        send_closed(&h.out);
        h.settle().await;
        h.out.ack(WINDOW);
        let all = h.finish().await.concat();
        // The marker first (it needs no credit), then the notice with the next output.
        let marker = all.find("<cleared>").unwrap();
        assert!(all[marker..].contains("[… 2.0 MB of output skipped]"));
        assert!(all.ends_with("^C\r\n$ <closed>"));
    }

    #[test]
    fn notices_say_how_much() {
        let n = |b| String::from_utf8(skipped_notice(b)).unwrap();
        assert!(n(500).contains("[… 1 KB of output skipped]"));
        assert!(n(3 * 1024 * 1024 + 1).contains("[… 3.0 MB of output skipped]"));
    }
}
