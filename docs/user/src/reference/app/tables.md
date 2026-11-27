# Resource tables

Every kind has a table, kept up to date by Kubernetes watches, not by
polling. Tables stay smooth with thousands of rows.

## Namespaces

Show one namespace, several at once (up to 10, one watch each) or all of
them. Click a **Namespace** cell to show only that namespace.

## The filter

The filter box above every table matches what the table shows: the name,
the namespace and the columns that are on. A column you turned off, or one
that is off by default (like **QoS** or **IP**), is not matched. Turn it on
in **Columns** to filter by it.

- **Aa Match case** matches case. The toggle is filled when it is on.
- **.\* Regex** takes a regular expression. `^` and `$` match at the start and end
  of each column. A regex that runs too long is stopped.
- A leading `!` inverts a text filter: `!Completed` shows the rows that do
  not contain it.
- `Z`, or the warning mark in the toolbar, keeps only the rows that need
  attention.
- When a name is cut in the middle and the filter matches only the hidden
  part, the cell is highlighted and its tooltip shows the whole name.
- `Enter` remembers a search and **☆ Star** stars it. `ArrowDown` in the box
  offers your starred and recent searches, in any table.

## Columns

- Each column is as wide as its values. Spare width goes to **Name**. When
  room runs short, long text gives way first; Ready, Status, Restarts, Age,
  CPU and Memory are never cut. Only when even that does not fit does the
  table scroll sideways.
- A name that is too long is cut in the middle, so its end stays visible
  (`payments-worker-canary-…-x7k2p`). Hover it for the whole name.
- Drag a header's right edge to resize the column. Double-click the edge to
  fit the column to its values; double-click again to let it size itself.
  Widths are remembered per kind.
- **Status** cells start with an icon in their colour, so the state does not
  depend on colour alone.
- **Ages** are printed like `kubectl get` (`7d20h`, `3h12m`). Hover an Age
  cell, or open the detail panel, for the creation time (local time or UTC,
  per Settings).
- The **Columns** button lists the table's columns in their order. Turn one
  off or on with its checkbox. Drag a column by its handle, or press
  **Alt+↑** or **Alt+↓** on it, to move it. Optional columns that are off
  wait under **More columns**. With many columns, **Find a column** narrows
  the list.
- Right-click a column header to **Hide this column**, or choose
  **Columns…** to open the same list.
- **Reset to default** turns every usual column back on and the optional
  ones off, puts them back in their order and lets them fit their values
  again. Your own columns stay.
- What you choose, and the order, is remembered per kind.
- Click a column header to sort; the sort is remembered per kind.

### Your own columns

**Columns → + Add column…** adds a column from the objects the table already
shows, with no extra requests to the cluster. Give it a name, and pick what
it shows:

- **Label**: a label key, for example `app.kubernetes.io/version`.
- **Annotation**: an annotation key, for example
  `deployment.kubernetes.io/revision`.
- **Field path**: a path into the object, starting with a dot:
  `.spec.priorityClassName`, `.status.podIP`, `.spec.containers[0].image`.
  Only names and number indexes like `[0]` work; `[*]` and filters do not.

If something is wrong, the form says what. A cell shows one line, at most
200 characters. An object shows as `{…}` and a list of objects as
`[3 items]`; point the path at a field inside them. Edit or remove a column
with the buttons next to it in the list. A table can have 10 of your own
columns. They are saved per kind; for a custom resource, per cluster
context. Hover a header to see where its column reads from.

On Secrets, a column cannot read `.data` or `.stringData`, or the
`kubectl.kubernetes.io/last-applied-configuration` annotation: their values
only show in the Secret's panel, after **Reveal**. Another annotation on a
Secret that holds JSON shows as `{…}`, and one that spans lines or is longer
than 63 characters shows as **(hidden: open the Secret)**: read it in the
Secret's panel. The same goes for a field path under
`.metadata.annotations`.

### Pods

The optional columns are **Controlled By** (a link to the owner), **QoS**,
**IP**, **Nominated Node**, **Containers** and **Image**.

**Containers** has one square per container, init containers first:

| Square | Meaning |
| --- | --- |
| Filled green | Ready |
| Half filled amber | Running but not ready, or starting |
| Red with a cross | Crash-looping, image pull failing, or exited with an error |
| Hollow grey | Completed |
| Dashed | No status yet |

Hover a square for the container's name, state and reason. Sorting by the
column puts pods with a broken container first.

### Images and vulnerabilities

**Image** is an optional column of Pods, Deployments, StatefulSets,
DaemonSets, ReplicaSets, Jobs and CronJobs. It shows the first container's
image and tag (`mongo:7.0.1`), with `+2` when there are more containers
(init containers are not counted). Hover it for every container's full
image, with its registry, and for a pod the digest it runs.

**Vulns**, on the same tables except ReplicaSets, is offered only while
[image security](../../how-to/image-security.md) is on for the cluster.
`2C 5H` means 2 critical and 5 high vulnerabilities, at the severity you
chose to count; **None** means none, and **Not scanned** that no report
covers the image yet. **KEV** (as in `KEV 2H`) means one of them is known to
be exploited in the wild; ignored vulnerabilities are not counted. Hover it
for each image. It sorts by severity, known exploited first: one critical
outweighs any number of high ones.

### Deployments, StatefulSets, DaemonSets

The **Status** column says what the controller is doing, each with its own
shape:

| Status | Meaning |
| --- | --- |
| Running (green) | All is well |
| Scaling, Updating (amber) | A change is rolling out |
| Failed (red) | The rollout is past its deadline, or a pod could not be created |
| Paused, Scaled down (grey) | Nothing runs by choice |

Hover it for why; sort by it to see broken rollouts first.

### Roles and bindings

Roles and bindings show their rules, the role they grant and their subjects,
as links.

### Usage

Pods and Nodes show CPU and memory usage when the metrics API is available,
with a small trend line of the last 30 minutes. Memory reads in KiB, MiB
and GiB; hover a CPU value to see it in cores ("250m (0.25 cores)"). See
[Metrics and Prometheus](metrics.md).

## Links in cells

Click a **Namespace** cell to show that namespace only, a **Node** cell to
open the node, a **Controlled By** cell to open the owner.

## Row actions

Hover a row (or focus it) to show its **Logs**, **Shell** and **Edit YAML**
buttons at its end. Every row also ends in a **⋮** button with all of the
row's actions: the same menu as a right-click, or `Shift+F10` on the focused
row. The menu shows each action's key (Logs `L`, Shell `S`, Edit YAML `E`,
Copy as prompt `A`, Rollout restart `⇧R`, Delete `Del`). Select several rows (`Space`) to act on all of them from the selection bar. See
[Actions](actions.md).

## Empty tables

An empty table says why, and offers the one thing that helps:

- **The filter hides every row**: `No Deployments match "checkout"`, how
  many it hides, and **Clear filter**. The filter stays on as you go from
  table to table, so it may come from the last table you filtered.
- **The namespace has none**: **All namespaces**, and **Create…** for kinds
  you can create.
- **No access**: "No access to Secrets in namespace team-b", with the
  permission you are missing.
- **Only problems shown** (`Z`): "No Pods need attention", with **Show all**.
- **Still loading**: "Loading Pods…", only when it takes more than a moment.

When the cluster has no metrics API, the Pods and Nodes tables say that the
CPU and memory columns are empty because of it, and offer **Install
metrics-server…**.

## Export CSV

**Export CSV** in the toolbar saves the rows and columns you see (filter,
sort and column choice) to a file you pick. Cells a spreadsheet would run as
formulas are written as text. Secrets export only their names, types and key
counts, as the table shows them.

## Density

**Compact table rows** in Settings fits more rows on screen.
