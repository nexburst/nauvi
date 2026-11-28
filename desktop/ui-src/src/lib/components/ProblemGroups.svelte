<script lang="ts">
  import type { Snippet } from "svelte";
  import type { EventInfo, PodCounts, ProblemGroup, ProblemPod, ResourceKind } from "../bindings";
  import { kinds, openObject, openWithStatus } from "../stores/app.svelte";
  import { openDockTab } from "../stores/dock.svelte";
  import { dockMenuFor } from "../dock";
  import { ownerTarget } from "../owner";
  import { GROUPS_SHOWN, groupCounts, seeAllProblems } from "../overview";
  import { PROBLEMS_STATUS } from "../workloads";
  import { eventTimes } from "../format";
  import { reasonWords } from "../eventText";
  import { stripPodIds } from "../warningGroups";
  import type { Blip } from "../sonar";
  import Icon from "../icons/Icon.svelte";
  import CalmWater from "./CalmWater.svelte";

  /**
   * The Overview's Problem groups (#605): the Problem pods of one workload
   * with one reason as one row, at most five, the rest one link away.
   * `actions` adds buttons after Logs and Describe on each row (#607).
   */
  let {
    pods,
    recovered = [],
    now,
    actions,
  }: { pods: PodCounts; recovered?: Blip[]; now: number; actions?: Snippet<[ProblemGroup]> } = $props();

  const podKind = $derived(kinds.all.find((k) => k.id === "v1/pods"));
  const groups = $derived(pods.groups.slice(0, GROUPS_SHOWN));
  const seeAll = $derived(seeAllProblems(pods));
  /** Pods listed in an expanded row; the rest are one link away. */
  const PODS_SHOWN = 10;
  let open = $state<Record<string, boolean>>({});

  /** What a row names and Describe opens: the workload, or the lone pod. */
  function target(g: ProblemGroup): { kind: ResourceKind; namespace: string; name: string } | null {
    if (g.owner_kind) return ownerTarget(kinds.all, `${g.owner_kind}/${g.owner_name}`, g.namespace);
    const pod = g.pods[0];
    return podKind && pod ? { kind: podKind, namespace: pod.namespace, name: pod.name } : null;
  }

  const nameOf = (g: ProblemGroup) => g.owner_name || g.pods[0]?.name || "";
  const kindOf = (g: ProblemGroup) => g.owner_kind || "Pod";
  /** A pending pod has no logs yet. */
  const hasLogs = (g: ProblemGroup) => g.pods.some((p) => p.status !== "Pending");

  function showLogs(g: ProblemGroup) {
    const t = target(g);
    const spec = t && dockMenuFor(t.kind.resource, t.namespace, t.name).find((m) => m.label === "Logs")?.spec;
    if (spec) return openDockTab(spec);
    // An owner without merged logs (a custom controller): its first pod's.
    const pod = g.pods.find((p) => p.status !== "Pending");
    if (pod) podLogs(pod);
  }

  function podLogs(p: ProblemPod) {
    if (podKind) openDockTab({ type: "podLogs", pod: { resource: podKind.resource, namespace: p.namespace, name: p.name } });
  }

  function describe(g: ProblemGroup) {
    const t = target(g);
    if (t) openObject(t.kind, t.namespace, t.name);
  }

  function openPod(p: ProblemPod) {
    if (podKind) openObject(podKind, p.namespace, p.name);
  }

  function openEvent(e: EventInfo) {
    if (podKind) openObject(podKind, e.object_namespace, e.object_name);
  }
</script>

{#if groups.length === 0}
  <div class="empty"><CalmWater mark="buoy"><p class="none">None.</p></CalmWater></div>
{:else}
  <ul class="row-list" data-testid="problem-groups">
    {#each groups as g (g.key)}
      {@const t = target(g)}
      {@const label = `${g.namespace}/${nameOf(g)}`}
      {@const expandable = g.owner_kind !== ""}
      {@const expanded = expandable && !!open[g.key]}
      {@const counts = groupCounts(g)}
      <li class="problem" class:error={g.error} data-testid="problem-group">
        <span class="state" aria-hidden="true"><Icon name={g.error ? "error" : "pending"} size={16} /></span>
        <div class="what">
          {#if t}
            <button type="button" class="name link" aria-label={label} title={`Open ${kindOf(g)} ${label}`} onclick={() => describe(g)}
              >{nameOf(g)}</button
            >
          {:else}
            <span class="name">{nameOf(g)}</span>
          {/if}
          <span class="reason">{g.reason}</span>
          <span class="where-box"><span class="where">{kindOf(g)} · {g.namespace}</span></span>
        </div>
        <span class="counts">{counts}</span>
        <div class="actions">
          {#if hasLogs(g)}
            <button type="button" class="row-act" aria-label={`Logs of ${label}`} onclick={() => showLogs(g)}>
              <Icon name="logs" size={14} />Logs
            </button>
          {/if}
          {#if t}
            <button type="button" class="row-act" aria-label={`Describe ${label}`} onclick={() => describe(g)}>
              <Icon name="describe" size={14} />Describe
            </button>
          {/if}
          {@render actions?.(g)}
        </div>
        {#if expandable}
          <button
            type="button"
            class="row-chev"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} the pods of ${label}`}
            title={expanded ? "Hide the pods" : "Show the pods"}
            onclick={() => (open = { ...open, [g.key]: !expanded })}><Icon name="chevronRight" size={16} /></button
          >
        {:else}
          <span></span>
        {/if}
        {#if expanded}
          <div class="more" data-testid="problem-group-pods">
            <ul class="pods">
              {#each g.pods.slice(0, PODS_SHOWN) as p (p.name)}
                <li>
                  <button type="button" class="link pod" aria-label={`${p.namespace}/${p.name}`} onclick={() => openPod(p)}
                    >{p.name}</button
                  >
                  <span class="muted">{p.reason}{p.restarts > 0 ? ` · ${p.restarts} restarts` : ""}</span>
                  {#if p.status !== "Pending"}
                    <button type="button" class="row-act" aria-label={`Logs of ${p.namespace}/${p.name}`} onclick={() => podLogs(p)}>
                      <Icon name="logs" size={14} />Logs
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if g.count > PODS_SHOWN}<p class="muted">And {g.count - PODS_SHOWN} more.</p>{/if}
            {#each g.events as e (e.key)}
              <p class="event">
                <span class="e-reason">{reasonWords(e.reason, e.message)}</span>
                <button type="button" class="link" onclick={() => openEvent(e)}>{e.object_name}</button>
                <span class="muted">{eventTimes(e.count, e.time, now)}</span>
                <span class="msg">{stripPodIds(e.message)}</span>
              </p>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
{#each recovered as r (r.key)}
  <div class="cleared" aria-live="polite">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.2l2 2 4-4.2" pathLength="10" />
    </svg>
    <span class="who">{r.key}</span>
    <span class="what">cleared</span>
  </div>
{/each}
{#if seeAll && podKind}
  <button type="button" class="see-all" data-testid="see-all-problems" onclick={() => podKind && openWithStatus(podKind, PROBLEMS_STATUS)}
    >{seeAll}</button
  >
{/if}

<style>
  .empty {
    padding: 4px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
  .none {
    margin: 0;
  }
  /* One line, 40 px: state · what · counts · actions · expand. */
  .problem {
    --tone: var(--amber);
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto auto 22px;
    align-items: center;
    column-gap: 10px;
    min-height: 40px;
    box-sizing: border-box;
    padding: 7px 8px 7px 12px;
  }
  .problem.error {
    --tone: var(--red);
  }
  .state {
    display: grid;
    place-items: center;
    color: var(--tone);
  }
  .what {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
    font-size: var(--text-base);
  }
  /* The kind and namespace give way first, then the name; the reason
     never. Too little room for the kind: it goes, not "D…". */
  .name {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: var(--weight-semibold);
    color: var(--text);
  }
  .where-box {
    flex: 1 1 0;
    min-width: 0;
    container-type: inline-size;
  }
  .where {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .reason {
    flex-shrink: 0;
    font-weight: var(--weight-semibold);
    color: var(--tone);
  }
  .counts {
    min-width: 10.5em;
    text-align: right;
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    min-width: 146px;
    gap: 6px;
  }
  .link {
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button.name:hover,
  .pod:hover {
    color: var(--accent);
  }
  .more {
    grid-column: 2 / -1;
    padding: 4px 0 2px;
    font-size: var(--text-sm);
  }
  .pods {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pods li {
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 28px;
  }
  .pods .muted {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pod {
    color: var(--text);
    font-weight: var(--weight-medium);
  }
  .muted {
    color: var(--text-muted);
    margin: 0;
  }
  .event {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    margin: 6px 0 0;
  }
  .event .link {
    color: var(--accent);
  }
  .e-reason {
    font-weight: var(--weight-semibold);
  }
  .msg {
    flex-basis: 100%;
    font-family: var(--font-num);
    font-size: 12px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  @container (max-width: 64px) {
    .where {
      visibility: hidden;
    }
  }

  /* A problem that just cleared: a teal tick drawn once, then the line goes. */
  .cleared {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    font-size: var(--text-base);
    color: var(--accent);
    animation: cleared 2600ms var(--ease-out) both;
  }
  .cleared svg {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .cleared path {
    stroke-dasharray: 10;
    animation: tick 500ms var(--ease-out) 150ms both;
  }
  .cleared .what {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  @keyframes tick {
    from {
      stroke-dashoffset: 10;
    }
  }
  @keyframes cleared {
    0% {
      opacity: 0;
      transform: translateY(6px);
    }
    12%,
    75% {
      opacity: 1;
      transform: none;
    }
    100% {
      opacity: 0;
    }
  }

  /* Narrow: the counts and actions go under what they act on. */
  @container overview (max-width: 640px) {
    .problem {
      grid-template-columns: 18px minmax(0, 1fr) 22px;
      row-gap: 2px;
    }
    .counts,
    .actions {
      grid-column: 2;
    }
  }
</style>
