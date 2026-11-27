# Getting around

This page explains the sidebar, pins, the command palette and the history
that you use to move around.

Every button says what it does in a tooltip when you hover it, or at once
when you reach it with the keyboard.

## The sidebar

The **sidebar** on the left lists every kind of the cluster, each with its
icon and a count of what needs attention there. On a window 1280 px wide or
more, nauvi starts with it open as a column; on a narrower window it starts
collapsed. nauvi remembers what you chose last.

- Each section shows its common kinds first: **Workloads** (Pods,
  Deployments, StatefulSets, DaemonSets, Jobs, CronJobs), **Network**
  (Services, Ingresses, Port Forwards) and **Config** (Config Maps, Secrets,
  HPAs). **N more** under a section shows the rest; nauvi remembers which
  ones you opened. The kind you are on always stays in view.
- The sections are **Workloads**, **Network**, **Config**, **Storage**,
  **Cluster**, **Helm**, **Access Control**, **Device Resources** and
  **Custom Resources** (with their definitions). nauvi finds them through
  API discovery, so custom kinds are there too.
- Admission policies and their bindings sit under **Config**. **Device
  Resources** holds the DRA kinds: DeviceClasses, ResourceClaims,
  ResourceClaimTemplates and ResourceSlices.
- Admission-policy and device-resource kinds that the cluster doesn't serve
  stay in their section, greyed out; other kinds it doesn't serve are not
  listed. Kinds you aren't allowed to list are greyed out too.
- Click a section's title (or focus it and press Enter) to collapse it;
  nauvi remembers it.

The sidebar also holds the tree of clusters
([Clusters, windows and the catalog](clusters.md)).

### Filter kinds

**Filter kinds…** at the top of the sidebar finds a kind by its name, its
kubectl short name (`po`, `deploy`, `svc`) or its section, also inside
**N more**. `G` focuses it, `Enter` opens the first match, `Escape` clears
it. When nothing matches, it says so.

### Pins

Right-click a kind and choose **Pin to top** to keep it at hand. Pinned
kinds show under **Pinned** at the top of the sidebar, and the keys `1` to
`9` jump to them (`1` is always the **Overview**). You can pin up to eight.
`P` pins the view on screen. **Unpin** in the same menu removes a pin.

### Collapsed

The collapse button at the top of the sidebar folds it into a narrow rail:
the Overview and your pins as icons, each with its kubectl short name and
its key. **All kinds** (`G`) at the foot of the rail opens every kind over
the window; type a name and press Enter to go there. **Keep open** makes it
a column again, and so does the expand button at the foot of the rail.

## The command palette

`Ctrl+K` (`Cmd+K` on macOS) opens the palette. It jumps to any kind
(`deploy`, `svc`, `cm` work), namespace, context or object, and runs actions
when you start with `>`.

- `ns ` narrows it to namespaces, `ctx ` to contexts.
- `win ` ("Open context in new window…") opens a context in a new window.
- **Describe** opens the focused object's panel; **Copy kubectl describe**
  copies its describe text (the same as `nauvi describe`).

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
| `Shift+R` or `R` | Restart its workload (always asks first) |
| `D` or `Enter` | Open its details |
| `Shift+F` | Port-forward it |
| `Shift+J` | Open its owner |
| `O` | Open the pod's node |
| `A` | Copy a prompt about it for your own coding agent |
| `W` (in the detail panel) | Give the object the whole window, and give the table back |

The row menu (**⋮**) shows the same keys next to its actions. Hovering a
row shows its Logs, Shell and Edit YAML buttons.

[Keyboard shortcuts](keyboard.md) lists every key.
