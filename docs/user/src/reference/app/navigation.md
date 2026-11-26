# Getting around

nauvi has no fixed sidebar. This page explains the berths, the drawer, the
command palette and the history that you use to move around.

## Berths

The window's left edge is a narrow column of **berths**: the places you keep
at hand. Each shows a kind by its kubectl short name (`po`, `dep`, `svc`)
with a count of what needs attention there.

- The first berth is always the **Overview**.
- Add up to eight more with `P`, or with the dashed cell that offers the view
  on screen. The app never adds one by itself.
- Remove one with its **✕** or a right-click.
- Jump to one with the keys `1` to `9`.

## The drawer

Every kind is in the **drawer**. Press `G`, or click the compass at the foot
of the berths, to open it. Type a kubectl name (`po`, `deploy`, `secrets`)
and press Enter to go there; the drawer closes again.

**Keep open** keeps the drawer as a column beside the table, the classic
layout. The handle at its left edge floats it again.

The drawer groups every resource type the cluster serves, built-in or
custom, found through API discovery:

- **Workloads**, **Network**, **Config**, **Storage**, **Cluster**,
  **Access control**, **Device resources** and **Custom resources** (with
  their definitions).
- Admission policies and their bindings sit under **Config**.
- **Device resources** holds the DRA kinds: DeviceClasses, ResourceClaims,
  ResourceClaimTemplates and ResourceSlices.
- Admission-policy and device-resource kinds that the cluster doesn't serve
  stay in their group, greyed out; other kinds it doesn't serve are not
  listed. Kinds you aren't allowed to list are greyed out too.
- Click a section's title (or focus it and press Enter) to collapse it;
  nauvi remembers it.

The drawer also holds the tree of clusters
([Clusters, windows and the catalog](clusters.md)).

## The command palette

`Ctrl+K` (`Cmd+K` on macOS) opens the palette. It jumps to any kind
(`deploy`, `svc`, `cm` work), namespace, context or object, and runs actions
when you start with `>`.

- `ns ` narrows it to namespaces, `ctx ` to contexts.
- `win ` ("Open context in new window…") opens a context in a new window.

## Back and forward

`Alt+←` / `Alt+→` (`⌘[` / `⌘]` on macOS), the mouse's back and forward
buttons, or the arrows in the header move back and forward through the
views, namespaces and objects you visited in this window. Switching context
clears that history.

## Verbs on the focused row

As in k9s, single keys act on the row that has focus. A line under the table
names the keys that apply.

| Key | What it does |
| --- | --- |
| `L` | Open its logs |
| `S` | Open a shell |
| `E` or `Y` | Open its YAML editor |
| `Shift+R` | Restart its workload (always asks first) |
| `A` | Copy a prompt about it for your own coding agent |
| `W` (in the detail panel) | Give the object the whole window, and give the table back |

The detail panel leads with what the table says is wrong
("CrashLoopBackOff · 12 restarts").

[Keyboard shortcuts](keyboard.md) lists every key.
