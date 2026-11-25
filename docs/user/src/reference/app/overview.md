# Overview and workloads

These views summarise a cluster: what needs a look, what runs, and how full
it is.

## Overview

The first berth. From top to bottom:

- a headline that says how many pods need a look;
- pod counts (crash-looping pods count as errors, not as running);
- the problem pods;
- CPU, memory and pod capacity against requests and usage. The CPU and
  Memory bars show limits next to requests, with a marker, and turn red when
  the limits exceed what the nodes can allocate;
- a 1-hour CPU and memory chart, from Prometheus when one is found or set in
  Settings, otherwise from metrics-server samples taken while the window is
  open;
- the newest warning events, each linking to its object.

It is kept live by watches, not by re-listing the cluster. Without
metrics-server it offers to install it ([Metrics](metrics.md#installing-metrics-server-or-prometheus)).

## The watch

The dial in the title bar shows how long the cluster has been calm (no
problem pods), or how many pods need a look. It opens a small sonar: the
calm streak, the last twelve hours, and a few insignia earned by keeping
watch. The line along the status bar is the same twelve hours, with a brass
knot where each problem cleared (hover it for what and when).

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
