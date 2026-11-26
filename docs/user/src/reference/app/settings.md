# Settings

Open Settings with the gear in the header, or `Ctrl+,` (`Cmd+,` on macOS).
Each cluster also has its own Settings page
([Clusters](clusters.md#a-clusters-settings)).

## App settings

The sections are Appearance, Editor and logs, Startup and updates, Clusters,
Metrics, Helm, Agents (MCP) and About nauvi; **All settings** shows them all
on one page. They hold:

- **Theme**: System, Dark or Light. The log viewer and terminals stay dark in
  both themes; the YAML editor follows the theme.
- **Log viewer** defaults.
- **Zoom and text**: the window zoom (50–200%) and the terminal font size
  (8–32 px), both remembered. A new font size applies to open terminals at
  once.
- **YAML editor**: font size and tab size.
- **Compact table rows**.
- **Times** in local time or UTC.
- **Background clusters**: when an unused cluster disconnects
  ([Clusters](clusters.md#background-clusters)).
- **Start at login** (off by default).
- **Updates**: the check on start, and a button to check now
  ([Update](../../how-to/update.md)).
- **Local terminal**: "Offer a kubectl that matches the cluster"
  ([The dock](dock.md#matching-kubectl)).
- **AI**: the custom command for [Ask AI](ask-ai.md), and the `nauvi` skill
  files it wrote, with **Remove**.
- **Agents (MCP)**: the `nauvi mcp` entries for agents without skills, and
  the agent guide ([MCP](../../how-to/mcp.md)).
- **Prometheus**: install a small Prometheus ([Metrics](metrics.md)).
- **Helm** repositories ([Helm](helm.md)).
- **About**: the version and commit, and **Copy diagnostics**
  ([Diagnostics](diagnostics.md)).

Settings are saved in `settings.json` in the app's config directory
([where](../../explanations/storage.md)).

## What nauvi remembers

- The last context and, per context, the view and namespaces.
- Per kind, the table sort and the hidden columns.
- The detail panel's width.
- Saved port forwards.
- The filter's recent and starred searches.
- The berths, and which drawer sections are collapsed.
- The windows open when you quit.
