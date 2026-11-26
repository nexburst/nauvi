# Detail panels

Click a row, or press `Enter` on it, to open its detail panel on the right.
Every object has one.

- The panel **leads with what is wrong**, in the words of the table
  ("CrashLoopBackOff · 12 restarts").
- Its header has the object's actions. **Logs**, **Shell** (or **Node
  shell**) and **Edit YAML** show their names; the others are icons with a
  tooltip, for example Scale and Restart on workloads, or Cordon and Drain on
  nodes. The destructive ones (Evict, Delete, Force delete) sit together on
  the right. **Copy link** copies a [`nauvi://` link](links.md) to the
  object.
- **✕** or `Esc` closes the panel.
- When a link opens an object (a problem pod on the Overview, a related
  object), its row in the table scrolls into view.
- Drag its left edge to change its width; nauvi remembers it.
- `W` gives the object the whole window and gives the table back. The YAML
  tab takes the whole window by itself.
- Hover the creation time for the exact time, in local time or UTC (per
  Settings).

## Pods

### Why it's failing

For a pod that needs a look, the panel starts with **Why it's failing**:

- what is wrong, in words: an image that cannot be pulled and why ("host
  registry.invalid not found"), a container that keeps crashing or running
  out of memory, a missing Secret, or "No node has enough CPU" for a pod no
  node can take;
- the container and its state ("Container app · CrashLoopBackOff");
- the last run's exit code and when it ended, and its termination message;
- the newest warning event;
- **Logs** (the failing container's logs), **Previous logs** (the run before,
  once the container runs again) and **Events (n) ↓**, which jumps to the
  events. For such a pod, the events come right after the containers.

### Containers

<img class="shot-light" src="../../img/pod-env-light.png" alt="A pod's detail panel with its environment">
<img class="shot-dark" src="../../img/pod-env-dark.png" alt="A pod's detail panel with its environment">

Each container card starts with a summary: image, command, args, requests,
limits, the number of environment variables, and the mounts with what each
volume is.

- **Environment** lists each variable with its value and where it comes from:
  a literal, a ConfigMap key (with its source), a pod field, or every key of
  an `envFrom` ConfigMap (with its prefix). Nothing is read until you open
  the list.
- **Secret values are hidden.** Env values from Secrets, and literal values
  that look like secrets, show as `••••` until you click **Reveal** on that
  row; **Hide** and closing the list drop them again. Without permission to
  read the Secret, the row says so.
- Values in command lines that look like secrets (`--token=`, `--password`,
  `…PASSWORD=`, passwords in URLs) are shown as `••••`.
- The panel has the pod's live logs (pick the container, or the previous
  instance of a crashed one) and an interactive terminal.
- CPU and memory charts against requests and limits
  ([Metrics](metrics.md)).

### Events

Events show the reason in words ("Failed scheduling", "Back-off
restarting"; hover it for the raw reason) and how often it happened ("821
times, last 41s ago"). A short summary in bold comes first ("No node fits: 1
node short of CPU, 2 nodes short of memory"), with the full message under
it. A message nauvi does not know how to sum up shows on its own.

## The last-applied annotation

The panel collapses kubectl's `last-applied-configuration` annotation.
**Show** opens it with secret-looking values masked the same way. The YAML
tab shows it as stored.

## Workloads and nodes

- Deployments, StatefulSets, DaemonSets, ReplicaSets and Jobs chart the summed
  CPU and memory of their pods.
- Nodes chart their usage against allocatable, and have Cordon, Drain and
  Shell in the header.

## Secrets and ConfigMaps

The panel lists their keys and lets you edit them: see
[Secret and ConfigMap data](data.md).
