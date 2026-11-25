# Keyboard shortcuts

nauvi can be used from the keyboard alone. Press `?` in the app for the full
list. On macOS, `Ctrl` in the shortcuts below is `⌘` where marked.

## Anywhere

| Key | What it does |
| --- | --- |
| `Ctrl+K` / `Cmd+K` | Command palette |
| `G` | Open the drawer of kinds |
| `1`–`9` | Go to a berth |
| `P` | Add the current view as a berth |
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
| `Enter` | Open the row |
| `Space` | Select the row |
| `Delete` | Delete (asks first; refused when not allowed) |
| `Shift+F10` | Open the row menu |
| `/` | Focus the filter |
| `Z` | Only the rows that need attention |
| `L`, `S`, `E` / `Y`, `Shift+R`, `A` | Logs, shell, YAML, restart, copy as prompt ([verbs](navigation.md#verbs-on-the-focused-row)) |

## In the filter box

| Key | What it does |
| --- | --- |
| `Enter` | Remember the search |
| `ArrowDown` | Offer your starred and recent searches |

## In a log tab

| Key | What it does |
| --- | --- |
| `Enter` / `Shift+Enter` in the search box, `n` / `N` in the log | Next / previous match (with Highlight) |

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
