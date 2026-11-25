# Read-only and protected clusters

A cluster's **Settings → Changes** sets how careful nauvi is with it.

| Mode | What happens |
| --- | --- |
| Normal | Changes ask for confirmation where they are destructive |
| **Protected** | You type the context's name before every change: actions, deletes, edits, Helm, terminals, starting a port forward |
| **Read-only** | Every change is refused, terminals included |

- Logs and port forwards work in both modes.
- The **backend enforces the mode**, not only the UI.
- The header and the catalog show a badge, and a cluster without a colour
  gets a red (protected) or amber (read-only) edge.
- Switching a cluster to read-only closes its terminals in every window,
  Ask AI tabs included.
- `nauvi mcp` refuses its write tools on such a context, even with
  `--allow-writes`.
