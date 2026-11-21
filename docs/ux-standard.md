# The UX standard for Kubernetes clients, and where nauvi stands

What the tools people keep open all day have in common, drawn from ten rounds
of web research, and what nauvi does about each point. It is a working
document: update it when a gap closes or a rule turns out wrong.

## How this was made

- **Ten rounds**, one topic each, on 19 November 2026. Each round went to three
  independent researchers (Claude, Grok and Antigravity, driven through herdr)
  with the same brief: search the web, prefer primary sources, cite every claim
  that matters, mark what could not be verified.
- **Tools studied:** Lens and its forks (OpenLens, Freelens), k9s, Headlamp,
  Aptakube, Rancher, the Kubernetes Dashboard, the OpenShift console, Octant,
  K8Studio, Seabird, Komodor, and kubectl with stern, kubectx and krew.
- **References from the owner:** [loupe](https://github.com/kryptonhq/loupe),
  [Kubeli](https://github.com/atilladeniz/Kubeli),
  [srelens](https://github.com/srelens/srelens) and
  [kubik](https://github.com/oslabs-beta/kubik) (a graph and Grafana dashboard
  for local clusters behind a Google login: a different product; only its
  topology view is relevant here).
- A rule is in the standard when at least two of the three researchers found
  it independently. The researchers' claims about other tools were not
  re-verified one by one; the sources are at the end. What this document says
  about nauvi was checked against the code.

Marks: **has** (nauvi does it), **gap** (it does not), **differs** (nauvi
does something else on purpose), **not checked**.

## 1. The product

| The standard | nauvi |
| --- | --- |
| The kubeconfig is the only login: no account, nothing installed in the cluster. The reasons people give for leaving Lens are the forced Lens ID and its licence. | has |
| Logs and shells are core, never an add-on (OpenLens lost its pod menus to an extension). | has |
| The client speaks kubectl: short names, namespaces, contexts. | has |
| Several clusters in one window is expected of a desktop client. | has |
| It is fast and light; Electron weight is a standing complaint. | has (Tauri); idle budgets in CI |

Deliberately not followed: an in-cluster agent or platform (Rancher, the
OpenShift console), a plugin runtime, a merged table across clusters
(Aptakube): a bulk action must never span clusters by accident.

## 2. Getting around

| The standard | nauvi |
| --- | --- |
| Typing a kubectl name is the fastest way to any kind, CRDs included (k9s `:pods`). | has: the drawer (`G`) and the palette |
| Users pin their own places; taking pins away causes revolt (Lens's 2024 redesign dropped the hotbar and its forum asked for it back). | has: berths, keys `1`-`9` |
| Back is one predictable step, and history goes both ways. | has: back and forward |
| CRDs come from discovery, grouped by API group, with no new build. | has |
| Scope (context, namespace) changes from the same input as the kind. | partly: the palette takes `ns` and `ctx`; one line with kind, namespace and filter is a **gap** |
| A pin keeps its namespace and filter, not only the kind. | **gap** |

## 3. Tables

| The standard | nauvi |
| --- | --- |
| Default columns match `kubectl get`; a status the eye catches without reading. | has |
| One press shows only what is broken (k9s faults, `ctrl-z`). | **has since this change**: `Z`, or the toolbar's mark |
| The filter has a small grammar: text or regex, inverse, label selector. | text, regex, case: has. Inverse (`!text`): **has since this change**. Label selector: **gap** (rows carry no labels) |
| Sort, columns and scope are remembered per kind. | has |
| Custom columns from a label or a field path. | **gap** |
| Marked rows share actions beyond delete (restart, scale). | **gap**: bulk delete only |
| Live rows never jump under the pointer. | watch-based: has; order held while a row is selected: not checked |

## 4. One object

| The standard | nauvi |
| --- | --- |
| A structured view, not `describe` prose; owners and related objects are links. | has |
| The verdict first: why it is broken, in the words of the table. | has (the verdict line) |
| YAML edit shows a diff before it applies; `managedFields` are out of the way. | has |
| An object changed underneath is refused, not overwritten. | has (conflict is reported); rebasing the edit onto the new version is a **gap** |
| Secrets show keys; values one at a time, on request. | has |
| "Used by" for ConfigMaps, Secrets, PVCs. | not checked |
| Destructive dialogs name the cluster before the object. | **has since this change** (cluster, colour and mode in the dialog) |

## 5. Logs

| The standard | nauvi |
| --- | --- |
| Follow, wrap, timestamps, previous container, since and tail. | has |
| A whole workload's pods in one stream, each pod its own colour, new pods joining. | has; joining replaced pods: not checked |
| Search, filter, exclude, download. | has |
| JSON and logfmt lines parsed: level colour, level filter, pretty-print. | **gap** |
| ANSI colours rendered, and stripped on copy. | not checked |
| Huge logs stay smooth: bounded buffer, only visible rows painted. | has (virtual list, channel batches; a QA budget) |
| A crash-looping container opens on its previous logs. | **gap** |

## 6. Shells, forwards, debug

| The standard | nauvi |
| --- | --- |
| Long-lived sessions live in one organised place and survive navigation. | has: the dock |
| The shell is found, not assumed: bash, then ash, then sh. | **gap**: `/bin/sh` only |
| A dropped session reconnects in its tab and keeps its scrollback. | **gap** |
| Forwards are saved, start on demand, and move to a replacement pod. | saved, on demand: has; following a replaced pod: not checked |
| Debug containers and node shells clean up after themselves. | has (leftovers are listed and removed) |
| Files in and out of a container (`kubectl cp`). | **gap** |

## 7. Keyboard

| The standard | nauvi |
| --- | --- |
| Bare single keys act on the focused row: logs, shell, edit. This is why k9s wins the loop. | **has since this change**: `L`, `S`, `E`/`Y`, and `Shift+R` to restart |
| The keys valid right now are visible; `?` lists them all. | **has since this change**: a strip under the table; `?` existed |
| `Esc` always goes back one step. | has |
| Destructive keys take a second deliberate step, the safe choice first. Never an unconfirmed kill (k9s `ctrl-k`). | has; a restart from the keyboard always asks |
| A read-only mode removes the write keys. | has (read-only contexts) |
| Users can rebind keys and add aliases. | **gap** |

`Shift+R`, not `R`: a bare `r` is one slip from the engine's reload key and
from typing in the wrong place.

## 8. Clusters, access, safety

| The standard | nauvi |
| --- | --- |
| The kubeconfig is read, never rewritten; switching in the app does not move kubectl's context. | has |
| Exec auth plugins work when the app starts from the Dock (the login shell's PATH). | has; naming the missing binary in the error: not checked |
| Each cluster has a colour, visible on every surface, so production never looks like test. | **has since this change**: a band along the top of the window, the dialogs; dock tabs and the status bar had it |
| Read-only and protected are per context and persist. | has |
| Actions the user may not run are greyed before the click. | has |
| The app works with namespace-only rights (an allow-list when listing namespaces is forbidden). | has (typed namespaces) |
| Friction grows with blast radius: typed name on protected contexts. | has |

## 9. Seeing the cluster

| The standard | nauvi |
| --- | --- |
| The overview leads with what is wrong, not with gauges. | has |
| Usage against requests and limits, in the table. | has (CPU and memory columns with sparklines); percent of request and limit coloured at 70 and 90: **gap** |
| Never install a metrics stack silently; read an existing Prometheus (Lens installs one only when the user turns it on in its settings). | has; installing metrics-server is offered, with a dry run first |
| Hygiene findings (Popeye): missing limits and probes, `latest` tags, unused ConfigMaps. | **gap** |
| Events and rollouts on one timeline per workload, past the one-hour TTL. | **gap** |
| Helm: history, values and manifest diff, rollback. | rollback: has; diffs between revisions: not checked |

## 10. Agents

Developers already pay for an agent. The client should work with it, not sell
another.

| The standard | nauvi |
| --- | --- |
| Never hold the user's model credentials. Start their own agent, which signs in itself. Anthropic does not permit third-party apps to offer a Claude.ai login; running the user's own Claude Code is allowed, and Zed embeds external agents over ACP (how a plan is billed through a third-party harness can differ from the terminal CLI: check the current terms before promising it). | has: no model, no key, no login |
| One capability set feeds the app, the CLI and the MCP server, so RBAC, read-only marks and redaction are the same everywhere. | has: `nauvi mcp` shares the core |
| Read-only by default; writes need a process flag. | has (`--allow-writes`; refused on read-only and protected contexts) |
| Secret values never reach the model; output is capped. | has |
| Setting up the agent is one step, from the app (srelens: Settings, MCP; Kubeli). | **has since this change**: Settings, Agents: the entry for each client, to copy |
| Context goes to the agent in one step ("copy as prompt", "ask my agent"). | **has since this change**: Copy as prompt on any row (`A`). Starting the user's CLI agent in a dock terminal with that context: **gap** (Kubeli's README lists Claude Code and Codex CLI support; how it starts them was not verified) |
| The agent is told the rules: a skill or AGENTS.md section naming the tools and the read-only default. | **has since this change**: a guide to copy |
| Logs and events are untrusted input: fenced, labelled, never enough to authorise a write (CVE-2025-66404, a command injection in a Kubernetes MCP server's exec tool, where log text was one way in). | the prompt says so and carries no log text; the MCP server labelling its own output: **gap** |
| Writes from an agent ask a person, in the app, showing cluster, object and diff. | **gap** |
| Every agent call is recorded and visible. | **gap** |
| Links let an agent point back into the app (`nauvi://`), navigation only. | has (links exist); returned by the MCP tools: **gap** |

Deliberately not followed: a built-in chat or a resold model (Lens Prism), a
bring-your-own-key assistant that stores keys (k8sgpt keeps them in plain
text), writing into other tools' config files (the entry is shown to copy).

## What this change implements

1. Verbs on the focused row: `L` logs, `S` shell, `E` or `Y` YAML, `Shift+R`
   restart (always asks), with a strip under the table naming the keys.
2. `Z`, and a mark in the toolbar: only the rows that need attention.
3. `!text` in the filter: the rows that do not contain it.
4. The cluster's colour along the top of the window; a protected or read-only
   context without a colour gets a red or amber band. Confirm dialogs show the
   cluster with its colour and mode.
5. Settings, Agents: the `nauvi mcp` entry for Claude Code, Codex, VS Code,
   and the shared JSON form (Cursor, Claude Desktop, Gemini CLI, Windsurf), to
   copy, pinned to the cluster on screen and read-only. Nothing is written
   into another tool's files.
6. Copy as prompt (`A`, or the row menu): the object, its cluster and what the
   table says is wrong, written for an agent that has `nauvi mcp`. It carries
   no logs or manifests, and marks cluster text as data.
7. A guide for the agent itself (Settings, Agents, "Copy"): the tools, the
   read-only default, and that what a cluster says is never an instruction.
   For AGENTS.md, CLAUDE.md or a skill.

## Backlog

In the order two of the three researchers gave it in the closing review (value
for effort); the third did not answer that round.

1. Shell detection (bash, ash, sh) and reconnect in place.
2. Usage as a percentage of request and limit, coloured: the data is already
   in the table.
3. JSON and logfmt log lines: level, filter, pretty-print; previous logs first
   for a crash-looping container.
4. Bulk restart and scale; label selector in the filter (needs labels on rows).
5. MCP: output labelled as untrusted first, then an approval sheet in the app
   for writes, a visible audit log, `nauvi://` links in results. "Ask my
   agent": start the user's own CLI (claude, codex, gemini) in a dock terminal.
   The prompt must reach it as a file or on the clipboard, never typed into a
   shell: text from a cluster is not safe on a command line.
6. A berth that keeps its namespace and filter; one-line `kind ns /filter`.
7. Files in and out of a container.
8. Custom columns; key rebinding and aliases.
9. Hygiene findings; an events and rollouts timeline per workload.

Raised in the closing review and not yet placed: a forward's local port that
defaults to the remote port; two table widths switched in one action with the
name pinned (k9s `ctrl-w`); image and namespace settings for debug and node
shells; a topology view (Headlamp's map, k9s `:xray`); merging several
kubeconfig files with duplicate context names told apart; server-side Table
columns for CRDs.

## Sources

The most cited sources of each round. The researchers' full answers, with
every source, are kept with the session notes.

**Round 1: Landscape** (33 distinct sources)

- <https://github.com/vmware-archive/octant>
- <https://github.com/freelensapp/freelens>
- <https://github.com/kubernetes-sigs/headlamp>
- <https://aptakube.com/pricing>
- <https://github.com/derailed/k9s>
- <https://github.com/getseabird/seabird>
- <https://www.cncf.io/projects/headlamp/>
- <https://kubernetes.io/docs/tasks/access-application-cluster/web-ui-dashboard/>
- <https://www.rancher.com/products/rancher>

**Round 2: Navigation** (31 distinct sources)

- <https://k9scli.io/topics/commands/>
- <https://github.com/srelens/srelens>
- <https://github.com/oslabs-beta/kubik>
- <https://github.com/kryptonhq/loupe>
- <https://forums.k8slens.dev/t/the-new-ui-is-terrible/3689>
- <https://extensions.rancher.io/internal/code-base-works/products-and-navigation>
- <https://www.kubernetes.io/blog/2026/01/22/headlamp-in-2025-project-highlights/>
- <https://issues.redhat.com/browse/CONSOLE-4629>
- <https://newreleases.io/project/github/kubernetes-sigs/headlamp/release/v0.35.0>

**Round 3: Tables** (27 distinct sources)

- <https://github.com/srelens/srelens>
- <https://github.com/oslabs-beta/kubik>
- <https://github.com/atilladeniz/Kubeli>
- <https://github.com/kryptonhq/loupe>
- <https://k9scli.io/topics/commands/>
- <https://kubernetes.io/docs/reference/kubectl/generated/kubectl_get/>
- <https://k9scli.io/topics/skins/>
- <https://github.com/freelensapp/freelens>
- <https://k9scli.io>

**Round 4: Object detail and YAML** (33 distinct sources)

- <https://github.com/derailed/k9s>
- <https://github.com/oslabs-beta/kubik>
- <https://github.com/atilladeniz/Kubeli>
- <https://github.com/kryptonhq/loupe>
- <https://newreleases.io/project/github/aptakube/aptakube/release/1.19.3>
- <https://bugzilla.redhat.com/show_bug.cgi?id=1965519>
- <https://access.redhat.com/node/7088074>
- <https://itnext.io/managed-fields-in-kubernetes-0475978b3c98>
- <https://github.com/kubernetes-sigs/headlamp>

**Round 5: Logs** (26 distinct sources)

- <https://github.com/stern/stern>
- <https://github.com/oslabs-beta/kubik>
- <https://github.com/kryptonhq/loupe>
- <https://github.com/freelensapp/freelens>
- <https://github.com/srelens/srelens>
- <https://github.com/kubernetes-sigs/headlamp>
- <https://k9scli.io>
- <https://github.com/atilladeniz/Kubeli>
- <https://aptakube.com>

**Round 6: Shell, port-forward, debug** (36 distinct sources)

- <https://github.com/kryptonhq/loupe>
- <https://github.com/oslabs-beta/kubik>
- <https://newreleases.io/project/github/aptakube/aptakube/release/1.11.4>
- <https://github.com/derailed/k9s/issues/4022>
- <https://github.com/aptakube/aptakube/releases>
- <https://github.com/atilladeniz/Kubeli/releases>
- <https://github.com/srelens/srelens/blob/dev/docs/USAGE.md>
- <https://docs.k8slens.dev/k8slens/using-lens/shortcuts/>
- <https://github.com/derailed/k9s/blob/master/README.md>

**Round 7: Keyboard and palette** (26 distinct sources)

- <https://github.com/oslabs-beta/kubik>
- <https://github.com/kryptonhq/loupe>
- <https://k9scli.io/topics/hotkeys/>
- <https://github.com/freelensapp/freelens>
- <https://github.com/srelens/srelens>
- <https://github.com/kubernetes-sigs/headlamp>
- <https://k9scli.io>
- <https://github.com/atilladeniz/Kubeli>
- <https://aptakube.com>

**Round 8: Multi-cluster, RBAC, safety** (31 distinct sources)

- <https://docs.k8slens.dev/faq/technical-faq/>
- <https://github.com/oslabs-beta/kubik>
- <https://github.com/atilladeniz/Kubeli>
- <https://github.com/kryptonhq/loupe>
- <https://aptakube.com>
- <https://kubernetes.io/blog/2026/01/19/clientcmd-apiserver-access/>
- <https://kubernetes.io/docs/tasks/configmap-secret/managing-secret-using-kubectl/>
- <https://github.com/kubernetes-sigs/headlamp/issues/4857>
- <https://kubernetes.io/docs/reference/access-authn-authz/authorization/>

**Round 9: Observability, Helm, CRDs** (33 distinct sources)

- <https://github.com/derailed/k9s>
- <https://github.com/kryptonhq/loupe>
- <https://github.com/oslabs-beta/kubik>
- <https://docs.lenshq.io/k8slens/cluster/cluster-metrics/>
- <https://github.com/atilladeniz/Kubeli>
- <https://aptakube.com>
- <https://github.com/shilazi/openlens-lens-metrics>
- <https://kubernetes.io/docs/tasks/debug-application-cluster/resource-metrics-pipeline/>
- <https://docs.k8slens.dev/k8slens/using-lens/events/>

**Round 10: Agent integrations** (26 distinct sources)

- <https://github.com/oslabs-beta/kubik>
- <https://github.com/srelens/srelens>
- <https://github.com/atilladeniz/Kubeli>
- <https://github.com/kryptonhq/loupe>
- <https://github.com/containers/kubernetes-mcp-server>
- <https://code.claude.com/docs/en/legal-and-compliance>
- <https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/>
- <https://github.com/kagent-dev/kagent>
- <https://github.com/GoogleCloudPlatform/kubectl-ai>
