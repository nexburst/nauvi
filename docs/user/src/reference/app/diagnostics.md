# Notifications, errors and diagnostics

## Notifications

The bell in the title bar keeps the notices and errors this window has shown
(the last 200, until the window closes), with their time, context and a link
to the object. It opens as a popover; `Esc` or a click elsewhere closes it,
and what arrives meanwhile counts as unread. **Clear all** empties it.

## When a cluster does not answer

- A view that **cannot start** is retried with a growing wait (5, 10, 20, 40
  seconds, then every minute). After about five minutes it stops, and the
  error says "Stopped retrying. Refresh to try again." Refresh, a context
  switch or opening the view again starts over. The error is one
  notification, however many retries it took.
- A view that **was live and lost its connection** shows Reconnecting while
  the app tries again (every second at first, every ten at most). After five
  minutes of that without a break it is stopped the same way, and what it
  showed stays on screen, dimmed.
- Logs, terminals and port forwards are not part of this: they keep their
  own connections.

The status bar says `Stale since <time>` while the rows are not current.

## Help and diagnostics

The Help menu (the `?` in the header; on macOS also in the menu bar) has:

- **Documentation**: these docs, for the version you run.
- **Report a bug**: opens a GitHub issue with the version, commit, OS and
  webview filled in.
- **Open log folder**.
- **About**.

**Settings → About** shows the version and commit and has **Copy
diagnostics** (nothing about your clusters).

## The app log

The app log is `nauvi.log` in:

| Platform | Folder |
| --- | --- |
| Linux | `~/.local/share/com.nauvi.app/logs/` |
| macOS | `~/Library/Logs/com.nauvi.app/` |
| Windows | `%LOCALAPPDATA%\com.nauvi.app\logs\` |

It is rotated at 2 MiB (3 files kept). On Linux and macOS only you can read
it (mode 0600). Secret-looking text is masked, but check the log before you
share it. `NAUVI_LOG=debug` logs more.
