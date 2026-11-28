# Overview and workloads

These views summarise a cluster: what needs a look, what runs, and how full
it is.

## Overview

The first view of a cluster (key `1`). It shows what needs a look now, and
it fits one screen however big the cluster is. From top to bottom:

- a line that names the context and the scope ("kind-dev · all
  namespaces", or "kind-dev · namespace team-a"), and a headline that says
  how many pods need a look, with a status tile beside it. With nothing
  wrong it reads "No problems in kind-dev";
- pod counts as cards (crash-looping pods count as errors, not as running);
  the Errors card turns red when there are any. Each card opens its table:
  **Errors** opens Pods that need attention, **Pending** the Pending pods,
  **Nodes ready** (when some are not ready) the Nodes that need attention.
  Failed and Succeeded show as one muted line under the cards while both
  are 0. With [image security](../../how-to/image-security.md) on, an
  **Image fixes** card counts the images that have a fix waiting; a click
  opens the Image security view. It is not a problem count;
- the [Problem groups](#problem-groups);
- the [Warning groups](#warning-groups).

In the right column (under the rest in a narrow window):

- CPU, memory and pod capacity against requests and usage, in one card. The
  CPU and Memory bars show limits next to requests, with a marker, and turn
  red when the limits exceed what the nodes can allocate;
- a 1-hour usage chart, from Prometheus when one is found or set in
  Settings, otherwise from metrics-server samples taken while the window is
  open. It shows CPU or Memory: switch with the two buttons above it. It
  starts once it has three samples ("Collecting usage, first points in
  about a minute.");
- pods by namespace, with each namespace's share: the 5 biggest, then a
  line such as "35 more namespaces, 3920 pods".

It is kept live by watches, not by re-listing the cluster. Without
metrics-server it offers to install it ([Metrics](metrics.md#installing-metrics-server-or-prometheus)).

### Problem groups

The problem pods of one workload that share one reason are one row: a
Deployment with 40 crash-looping pods is one line, not forty. The row shows
the workload's name, the reason, its kind and namespace, how many of its
pods have the problem ("40 of 42 pods") and the restarts.

- **Logs** opens the workload's logs, all its pods merged, in the dock.
- **Describe** opens the workload.
- The chevron at the end opens the row: its first 10 pods, each a link with
  its own **Logs**, and the newest warning events of those pods.
- A pod that no workload owns is a row of its own.
- A crash-looping pod flips between `Error` and `CrashLoopBackOff`; both
  count as one reason, so its workload stays one row.

The Overview shows at most 5 groups, errors first, then the ones with the
most pods. The heading counts them all. **See all 166 problem pods →**
opens Pods filtered to *needs attention*.

### Warning groups

Warning events with one reason on the objects of one owner are one row:
"Back-off restarting · 3 pods of Deployment web · 212× · 20m ago". An event about a
single object links to it. Hover a row for its summary; the chevron shows
the summary and the full message.

Warning events read the way a person reads them. The reason is in words
("Failed scheduling", "Back-off restarting"), a short summary comes first
("No node fits: 1 node short of CPU"), and "212×" says how often it
happened. Durations read "3m 5s", "3h 5m" or "8d 14h", and memory reads in
KiB, MiB and GiB.

The events of the pods in a Problem group are inside that group, not here.
The Overview shows at most 5 Warning groups; **See all warnings →** opens
Events filtered to *Status: Warning*.

With an AI CLI installed, Problem groups and Warning groups also have
**Ask AI** and **+** (add to the Ask AI list): see [Ask AI](ask-ai.md#starting-it).

## The problem pods pill

The pill in the header reads **N problem pods**, or **No problems**. Click
it for the list of problem pods: each one links to its detail panel and
shows its reason, with a **Logs** button (except on Pending pods). **Show on
the Overview** goes to the Overview. `Esc` closes the list.

The pill counts what the Overview found. Right after you switch cluster, or
before the Overview has been open, it reads **Problem pods** and offers
**Open the Overview**. While the Overview is not on screen, the list says
when it was last open.

## The watch log

The pill's second tab, **Watch log**, shows the last twelve hours: how long
the cluster has gone with no problem pods, the longest time with no problem
pods, and a few insignia earned by keeping watch. The line in the status bar,
**Problem pods, last 12h**, is the same twelve hours (hover it for the
legend: teal is none, an amber dip is some, a brass diamond is where a
problem cleared, grey is time when the Overview was not open). Click it to
open the watch log.

The watch is kept per context in the app's local storage, counts only while
the Overview is open, and never interrupts you.

## Workloads → Overview

What runs in the selected namespaces, and which workloads need a look. Like
the Overview, it fits one screen.

The headline names the context and the scope, and says how many workloads
need a look ("41 workloads need a look"), or "No workload problems in
kind-dev".

Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs
are counted by status (running, pending, failed, succeeded, suspended…),
live. A click on a count opens that kind's table showing just those rows.

**Problem workloads** lists the workloads that need a look (not all
replicas ready, failed Jobs, suspended CronJobs), one line each: kind,
namespace/name and reason ("0 of 3 ready"). It shows at most 5: failed ones
first, then the ones with the most pods not ready, then the oldest. **See
all 41 →** opens the kind's table filtered to problems; with problems of
several kinds there is one link per kind ("See all 9: 7 Deployments → 1 Job
→ 1 CronJob →").

**Warnings** are the same [Warning groups](#warning-groups) as on the
Overview, at most 5, with **See all warnings →**. The events of a listed
problem workload's pods are left out, since its row already says it needs a
look.

With an AI CLI installed, Problem workloads and Warning groups have
**Ask AI** and **+** here too.

## Applications

**Workloads → Applications** groups workloads by Helm release and by the
`app.kubernetes.io/instance` (or `name`) label, per namespace, with their
components, version and a rolled-up status. Click one to see its workloads
and open them, or its Helm release.
