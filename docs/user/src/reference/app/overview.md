# Overview and workloads

These views summarise a cluster: what needs a look, what runs, and how full
it is.

## Overview

The first view of a cluster (key `1`). From top to bottom:

- a headline that says how many pods need a look, with a status tile beside
  it;
- pod counts as cards (crash-looping pods count as errors, not as running);
  the Errors card turns red when there are any. With
  [image security](../../how-to/image-security.md) on, an **Image fixes**
  card after them counts the images that have a fix waiting; a click opens
  the Image security view. It is not a problem count;
- the problem pods, each a card with its reason ("Pending for 8d 14h",
  "CrashLoopBackOff · 12 restarts"), **Logs** (opens its logs in the dock;
  not on Pending pods) and **Describe** (opens it in the Pods view);
- CPU, memory and pod capacity against requests and usage, in one card. The
  CPU and Memory bars show limits next to requests, with a marker, and turn
  red when the limits exceed what the nodes can allocate;
- a 1-hour CPU and memory chart, from Prometheus when one is found or set in
  Settings, otherwise from metrics-server samples taken while the window is
  open;
- pods by namespace, with each namespace's share;
- the newest warning events as cards, each linking to its object.

Warning events read the way a person reads them. The reason is in words
("Failed scheduling", "Back-off restarting"; hover it for the raw reason),
a short summary comes first ("No node fits: 1 node short of CPU"), the full
message is under it, and "6 times, last 41s ago" says how often it
happened. Durations read "3m 5s", "3h 5m" or "8d 14h", and memory reads in
KiB, MiB and GiB.

It is kept live by watches, not by re-listing the cluster. Without
metrics-server it offers to install it ([Metrics](metrics.md#installing-metrics-server-or-prometheus)).

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

Pods, Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs
counted by status (running, pending, failed, succeeded, suspended…) in the
selected namespaces, live. A click on a count opens that kind's table
showing just those rows.

It also lists the problem workloads (not all replicas ready, failed Jobs,
suspended CronJobs) and the newest warnings about workloads.

## Applications

**Workloads → Applications** groups workloads by Helm release and by the
`app.kubernetes.io/instance` (or `name`) label, per namespace, with their
components, version and a rolled-up status. Click one to see its workloads
and open them, or its Helm release.
