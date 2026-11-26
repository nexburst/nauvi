# Resource tables

Every kind has a table, kept up to date by Kubernetes watches, not by
polling. Tables stay smooth with thousands of rows.

## Namespaces

Show one namespace, several at once (up to 10, one watch each) or all of
them. Click a **Namespace** cell to show only that namespace.

## The filter

The filter box above every table matches any column.

- **Aa** matches case.
- **.\*** takes a regular expression. `^` and `$` match at the start and end
  of each column. A regex that runs too long is stopped.
- A leading `!` inverts a text filter: `!Completed` shows the rows that do
  not contain it.
- `Z`, or the warning mark in the toolbar, keeps only the rows that need
  attention.
- `Enter` remembers a search and **☆** stars it. `ArrowDown` in the box
  offers your starred and recent searches, in any table.

## Columns

- **Ages** are printed like `kubectl get` (`7d20h`, `3h12m`). Hover an Age
  cell, or open the detail panel, for the creation time (local time or UTC,
  per Settings).
- The **Columns** button hides columns; its **More columns** has optional
  columns that are off by default, and **Default columns** goes back to the
  default set. The choice is remembered per kind.
- Click a column header to sort; the sort is remembered per kind.

### Pods

The optional columns are **Controlled By** (a link to the owner), **QoS**,
**IP**, **Nominated Node** and **Containers**.

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
with a small trend line of the last 30 minutes. See
[Metrics and Prometheus](metrics.md).

## Links in cells

Click a **Namespace** cell to show that namespace only, a **Node** cell to
open the node, a **Controlled By** cell to open the owner.

## Row actions

Every row ends in a **⋮** button with the row's actions: the same menu as a
right-click, or `Shift+F10` on the focused row. Select several rows (`Space`) to act on all of them from the selection bar. See
[Actions](actions.md).

## Export CSV

**Export CSV** in the toolbar saves the rows and columns you see (filter,
sort and column choice) to a file you pick. Cells a spreadsheet would run as
formulas are written as text. Secrets export only their names, types and key
counts, as the table shows them.

## Density

**Compact table rows** in Settings fits more rows on screen.
