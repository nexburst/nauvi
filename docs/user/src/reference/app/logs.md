# Logs

nauvi streams logs live into a tab of the [dock](dock.md). Open them with `L`
on a row, **Logs** in the detail panel's header, or the row menu.

<img class="shot-light" src="../../img/logs-light.png" alt="A pod's logs in a dock tab">
<img class="shot-dark" src="../../img/logs-dark.png" alt="A pod's logs in a dock tab">

## The toolbar

The log tab has one row of controls: the container, **Previous**, the search
box with its options and match count, the line count, **Following**,
**Options ▾** and **Download**. The line above it says which pod, container
and run you see.

- **Following** keeps the newest line in view. Click it to pause: it then
  reads **Paused**, and a click shows the lines that came in and follows
  again. After you step to a match it reads **Follow**; click it to go back
  to the newest line. Scrolling up keeps the view where it is.
- **Options ▾** holds **Tail lines**, **Since**, **Timestamps**, **Wrap**,
  **Exclude**, **Context**, **Jump to time** and **Clear**. A badge on the
  button counts the options you changed from their defaults. `Esc` closes
  the menu.
- A log tab opens the dock to about half the window, until you size the dock
  yourself; then your height wins.

## Pod logs

Pick the container, or tick **Previous** for the run before the current
one. The line above the log says which run you see:

- `current run, started 2s ago after 1 restart`
- `previous run, exited with code 1, 31s ago`
- `last run, exited with code 137 (OOMKilled), 3m ago; waiting to restart:
  CrashLoopBackOff`: while a container waits to restart, its log already
  is the run that crashed, without ticking **Previous**.

With **Previous** on, Follow is off (a finished run cannot be followed), and
the log ends with `[end of the previous run]`.

If a container restarted and its new run has not logged anything yet, a bar
says "This run has not logged anything yet." with **Show the run that
crashed**.

When there is nothing to show, nauvi says why in plain words: the container
has no previous run, it has not started yet, or the previous run's logs are
no longer on the node (Kubernetes keeps only the last finished run).

## Workload logs

Follow every pod of a Deployment, StatefulSet, DaemonSet or Job in one
stream, including pods that a rollout replaces.

## Search

- **Aa** matches case, **.\*** takes a regular expression.
- **Highlight** keeps every line and steps through the matches with `Enter`
  / `Shift+Enter` in the search box, or `n` / `N` in the log. Going to a
  match stops following; click **Follow** to go back to the newest line.
- **Exclude** (under **Options**) hides the lines that match its text.
- **Context** (under **Options**) shows ±N lines around each match.
- **Jump to time** (under **Options**) goes to a time of day or a date
  (needs Timestamps).

## Downloads

A downloaded log starts with a `#` header that says where the lines came from
and which filter was on.

## Limits

At most 10 log streams run at once. A pod's log stream is bounded, so a flood
of lines waits in the API server instead of piling up in the app.

The log viewer's defaults are in [Settings](settings.md). The log viewer stays dark in both themes.

The CLI has the same: [`nauvi logs`](../cli/logs.md).
