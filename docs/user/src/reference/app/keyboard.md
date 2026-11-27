# Keyboard shortcuts

nauvi can be used from the keyboard alone. Press `?` in the app for the full
list. On macOS, `Ctrl` in the shortcuts below is `⌘` where marked.

## Anywhere

| Key | What it does |
| --- | --- |
| `Ctrl+K` / `Cmd+K`, or `Ctrl+P` / `Cmd+P` | Command palette (with [k9s keys](#k9s-keys) on, `Ctrl+K` kills a pod outside macOS) |
| `G` | Filter the kinds in the sidebar, or open all kinds when it is collapsed |
| `1`–`9` | Go to the Overview (`1`) or a pinned kind |
| `P` | Pin the current view |
| `?` | List every shortcut |
| `Ctrl+,` / `Cmd+,` | Settings |
| `F5` or `Ctrl+R` (`⌘R`) | Refresh the current view (it never reloads the window) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (`⌘` on macOS) | Zoom in, zoom out, reset the zoom |
| `Alt+←` / `Alt+→` (`⌘[` / `⌘]`) | Back and forward |
| `` Ctrl+` `` or `Ctrl+J` (`⌘J`) | Hide or show the dock |
| ``Ctrl+Shift+` `` or `Ctrl+Shift+J` (`⇧⌘J`) | New local terminal |

`` Ctrl+` `` is the key left of `1` (or next to the left Shift), so it also
works on layouts where the backtick is a dead key.

## In a table

| Key | What it does |
| --- | --- |
| Arrow keys, `j` / `k` | Move through the rows |
| `Enter` or `D` | Open the row's details |
| `Space` | Select the row |
| `Ctrl+Space` | Select every row from the last selected one to this one |
| `Ctrl+\` | Clear the selection |
| `Delete` or `Ctrl+D` (`⌘⌫` on macOS) | Delete the selected rows, or the focused one (asks first; refused when not allowed) |
| `Shift+F10` | Open the row menu |
| `/` | Focus the filter |
| `:` | Go to a kind, as in k9s's command mode: `:` then `pods` or `deploy` |
| `Z` | Only the rows that need attention |
| `L`, `S`, `E` / `Y`, `Shift+R` or `R`, `A` | Logs, shell, Edit YAML, restart, copy as prompt ([verbs](navigation.md#verbs-on-the-focused-row)) |
| `S` on a workload that scales (Deployments, StatefulSets, ReplicaSets) | Scale |
| `Shift+F` | Port-forward the row |
| `Shift+J` | Jump to the row's owner (ReplicaSet, Deployment, Job, CronJob…) |
| `O` | Open the pod's node |
| `Shift+C` / `Shift+M` / `Shift+N` / `Shift+A` / `Shift+S` | Sort by CPU, memory, name, age or status; again for the other way. Only for columns the table shows |

### Confirm dialogs

A dialog that asks first opens with its confirm button (**Delete**,
**Restart**…) focused: `Enter` confirms, `Escape` cancels. `Tab`,
`Shift+Tab` and `←` / `→` move between its buttons and stay inside the
dialog. When the dialog has a field, such as a replica count or a name to
type, the field gets the focus instead. On a protected cluster the
type-the-context-name field always comes first, so pressing `Enter` twice
never deletes there.

So `j` `Space` `j` `Space` `Ctrl+D` `Enter` deletes two pods without the
mouse.

### k9s keys

**Settings → Keyboard → k9s keys** (off by default) adds the k9s keys that
clash with nauvi's own:

- `Ctrl+K` kills the focused pod (Force delete, asks first). The command
  palette is then `Ctrl+P` on Linux and Windows; on macOS it stays `⌘K`.
- `Shift+L` opens the logs of the pod's previous run (`P` keeps a view in
  a berth).

`?` lists them only while the setting is on.

### Coming from k9s

| k9s | nauvi |
| --- | --- |
| `Ctrl+D` delete | `Ctrl+D` (also `Delete`, `⌘⌫`), asks first |
| `Ctrl+K` kill | `Ctrl+K` with **k9s keys** on; otherwise row menu → **Force delete…** |
| `d` describe | `D` (or `Enter`) opens the details |
| `l` logs | `L` |
| `p` previous logs | `Shift+L` with **k9s keys** on |
| `s` shell | `S`; on Deployments, StatefulSets and ReplicaSets `S` opens **Scale** |
| `a` attach | row menu → **Attach** (`A` copies a prompt; `Shift+A` sorts by age) |
| `e` edit | `E` |
| `y` YAML | `Y` (opens the YAML editor) |
| `Shift+F` port-forward | `Shift+F` |
| `Shift+J` jump to owner | `Shift+J` |
| `o` node | `O` |
| `r` restart | `R` or `Shift+R`, asks first |
| `Space` / `Ctrl+Space` / `Ctrl+\` mark, mark range, clear | The same |
| `Shift+C/M/N/A/S` sort | The same, for the columns the table shows |
| `:pods` command mode | `:` then `pods` (or `G` and the kind, or the palette) |
| `Ctrl+W` wide columns | The **Columns** menu |
| `?` help | `?` |
| `z` sanitize | `Z` shows only the rows that need attention |

None of these keys act in a terminal, the log search, the filter or any
other text field.

## In the sidebar filter

| Key | What it does |
| --- | --- |
| `Enter` | Open the first matching kind, or the kind of a kubectl short name |
| `Escape` | Clear the filter |

## In the filter box

| Key | What it does |
| --- | --- |
| `Enter` | Remember the search |
| `ArrowDown` | Offer your starred and recent searches |

## In a log tab

| Key | What it does |
| --- | --- |
| `Enter` / `Shift+Enter` in the search box, `n` / `N` in the log | Next / previous match (with Highlight) |
| `Escape` | Close the **Options** menu |

## In a terminal

| Key | What it does |
| --- | --- |
| `Ctrl+Shift+F` (`⌘F`) | Search the terminal's output; `Enter` / `Shift+Enter` next / previous, `Esc` closes |

Inside a terminal, keys go to the shell: plain `Ctrl+F`, `F5` and `Ctrl+R`
reach the shell, and on Linux and Windows so does `Ctrl+J` (use `` Ctrl+` ``
to toggle the dock there).

## In the detail panel

| Key | What it does |
| --- | --- |
| `W` | Give the object the whole window, and give the table back |
