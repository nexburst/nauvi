//! Flow control of a pod log stream (#397), like the terminals' (#372):
//!
//! - **Bounded queue.** The reader hands lines to the batcher through a
//!   channel of `QUEUE_LINES`; when it is full the read waits, so a log
//!   that floods faster than the tab shows it stays in the API server's
//!   buffers, not in the app. Unlike a terminal, pausing a log read stalls
//!   nothing: the container writes to a file either way.
//! - **Credit.** At most `WINDOW` bytes of lines are on their way to the
//!   tab; it acknowledges each batch when it gets it (`cmd_log_ack`). A
//!   channel send never blocks, so without this a flood would pile up in
//!   the IPC queue.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// The most bytes of lines sent to the tab and not acknowledged yet.
pub(crate) const WINDOW: usize = 4 * 1024 * 1024;
/// The most lines waiting between the reader and the batcher.
pub(crate) const QUEUE_LINES: usize = 2000;

/// The bytes of one stream in flight to its tab. Cheap to clone.
#[derive(Clone)]
pub(crate) struct LogCredit(Arc<watch::Sender<usize>>);

impl Default for LogCredit {
    fn default() -> Self {
        Self(Arc::new(watch::Sender::new(0)))
    }
}

impl LogCredit {
    /// The tab got `bytes` of lines.
    pub(crate) fn ack(&self, bytes: usize) {
        self.0.send_modify(|b| *b = b.saturating_sub(bytes));
    }

    /// Bytes sent and not acknowledged yet.
    #[cfg(test)]
    fn in_flight(&self) -> usize {
        *self.0.borrow()
    }

    /// Wait until the window has room (a batch may then overshoot it once).
    async fn room(&self) {
        let mut rx = self.0.subscribe();
        let _ = rx.wait_for(|b| *b < WINDOW).await;
    }

    fn sent(&self, bytes: usize) {
        self.0.send_modify(|b| *b += bytes);
    }
}

/// A bounded channel for the reader (see the module docs).
pub(crate) fn queue() -> (mpsc::Sender<String>, mpsc::Receiver<String>) {
    mpsc::channel(QUEUE_LINES)
}

/// Collect lines from `rx` into batches of at most `max_lines` (or what
/// came within `interval` of a batch's first line) and hand each to `emit`
/// once `credit` has room; `emit` returns the bytes it sent. While it waits
/// for credit nothing is read from `rx`, so the reader waits too. Returns
/// after the last batch once the reader is gone.
pub(crate) async fn batch_with_credit<F>(
    mut rx: mpsc::Receiver<String>,
    max_lines: usize,
    interval: Duration,
    credit: LogCredit,
    mut emit: F,
) where
    F: FnMut(Vec<String>) -> usize,
{
    let mut batch: Vec<String> = Vec::new();
    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        let sleep = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        let full = tokio::select! {
            line = rx.recv() => match line {
                Some(line) => {
                    if batch.is_empty() {
                        deadline = Some(tokio::time::Instant::now() + interval);
                    }
                    batch.push(line);
                    batch.len() >= max_lines
                }
                None => break,
            },
            _ = sleep => true,
        };
        if full && !batch.is_empty() {
            deadline = None;
            credit.room().await;
            credit.sent(emit(std::mem::take(&mut batch)));
        }
    }
    if !batch.is_empty() {
        credit.room().await;
        credit.sent(emit(batch));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(lines: &[String]) -> usize {
        lines.iter().map(|l| l.len() + 1).sum::<usize>() - 1
    }

    #[tokio::test(start_paused = true)]
    async fn batches_by_size_and_interval_and_flushes_at_the_end() {
        let (tx, rx) = queue();
        let (out_tx, mut out) = mpsc::unbounded_channel();
        let credit = LogCredit::default();
        let task = tokio::spawn(batch_with_credit(
            rx,
            2,
            Duration::from_millis(50),
            credit.clone(),
            move |b| {
                let n = bytes(&b);
                out_tx.send(b).unwrap();
                n
            },
        ));
        for l in ["a", "b", "c"] {
            tx.send(l.into()).await.unwrap();
        }
        assert_eq!(out.recv().await.unwrap(), vec!["a", "b"]);
        // "c" alone: only the interval flushes it.
        assert_eq!(out.recv().await.unwrap(), vec!["c"]);
        tx.send("d".into()).await.unwrap();
        drop(tx);
        task.await.unwrap();
        assert_eq!(out.recv().await.unwrap(), vec!["d"]);
        assert_eq!(credit.in_flight(), 3 + 1 + 1);
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_acks_and_then_holds_up_the_reader() {
        // A short queue: the real one would hold 2000 of these lines.
        let (tx, rx) = mpsc::channel(4);
        let (out_tx, mut out) = mpsc::unbounded_channel();
        let credit = LogCredit::default();
        let line = "x".repeat(1024 * 1024);
        tokio::spawn(batch_with_credit(
            rx,
            1,
            Duration::from_millis(50),
            credit.clone(),
            move |b| {
                let n = bytes(&b);
                out_tx.send(n).unwrap();
                n
            },
        ));
        // A reader that sends as fast as it may.
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = {
            let sent = sent.clone();
            let line = line.clone();
            tokio::spawn(async move {
                loop {
                    if tx.send(line.clone()).await.is_err() {
                        break;
                    }
                    sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            })
        };
        tokio::time::sleep(Duration::from_secs(1)).await;
        // Four batches of 1 MB fill the window; the queue holds the rest.
        let mut got = 0;
        while let Ok(n) = out.try_recv() {
            got += n;
        }
        assert_eq!(got, WINDOW);
        // Four sent, one held by the batcher, four in the queue.
        let read = sent.load(std::sync::atomic::Ordering::SeqCst);
        assert!(read <= 4 + 1 + 4, "{read}");
        // An ack lets the next batch out.
        credit.ack(got);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(out.try_recv().is_ok());
        reader.abort();
    }
}
