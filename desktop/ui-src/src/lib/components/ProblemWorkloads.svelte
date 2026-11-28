<script lang="ts">
  import type { Snippet } from "svelte";
  import type { KindCounts, ProblemWorkload } from "../bindings";
  import { kinds, openObject, openWithStatus } from "../stores/app.svelte";
  import { PROBLEMS_SHOWN, seeAllWorkloads, toneOf, workloadKind, type SeeAllLink } from "../workloads";
  import CalmWater from "./CalmWater.svelte";

  /**
   * The Workloads overview's Problem workloads (#606): one 32 px line each
   * (kind · namespace/name · reason), at most five, errors first, then the
   * most pods affected; "See all N →" opens the kind's table filtered to its
   * problems. `actions` adds buttons to each row (#607).
   */
  let {
    problems,
    total,
    counts,
    actions,
  }: {
    problems: readonly ProblemWorkload[];
    total: number;
    counts: readonly KindCounts[];
    actions?: Snippet<[ProblemWorkload]>;
  } = $props();

  const rows = $derived(problems.slice(0, PROBLEMS_SHOWN));
  const links = $derived(seeAllWorkloads({ kinds: counts, problems, problems_total: total }));

  const kindOf = (k: { group: string; kind: string }) => workloadKind(kinds.all, k.group, k.kind);

  function open(p: ProblemWorkload) {
    const kind = kindOf(p);
    if (kind) openObject(kind, p.namespace, p.name);
  }

  function seeAll(l: SeeAllLink) {
    const kind = kindOf(l);
    if (kind) openWithStatus(kind, l.status);
  }

  /** "38 Deployments", "1 Job". */
  const label = (l: SeeAllLink) => `${l.count} ${l.count === 1 ? l.kind : (kindOf(l)?.label ?? `${l.kind}s`)}`;
</script>

{#if rows.length === 0}
  <div class="empty"><CalmWater mark="buoy"><p class="none">None.</p></CalmWater></div>
{:else}
  <ul class="row-list" data-testid="problem-workloads">
    {#each rows as p (p.kind + "/" + p.namespace + "/" + p.name)}
      {@const name = `${p.namespace}/${p.name}`}
      <li class="problem" class:error={toneOf(p.status) === "bad"} data-testid="problem-workload">
        <span class="kind">{p.kind}</span>
        {#if kindOf(p)}
          <button type="button" class="link name" title={`Open ${p.kind} ${name}`} onclick={() => open(p)}>{name}</button>
        {:else}
          <span class="name">{name}</span>
        {/if}
        <span class="reason" title={p.reason}>{p.reason}</span>
        <div class="actions">{@render actions?.(p)}</div>
      </li>
    {/each}
  </ul>
  {#if links.length === 1}
    <button type="button" class="see-all" data-testid="see-all-workloads" onclick={() => seeAll(links[0])}
      >See all {total} →</button
    >
  {:else if links.length > 1}
    <p class="see-all-kinds" data-testid="see-all-workloads">
      See all {total}:
      {#each links as l (l.group + "/" + l.kind)}
        <button type="button" class="see-all" onclick={() => seeAll(l)}>{label(l)} →</button>
      {/each}
    </p>
  {/if}
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
  /* One line, 32 px: kind · namespace/name · reason · actions. */
  .problem {
    --tone: var(--amber);
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 10px;
    min-height: 32px;
    box-sizing: border-box;
    padding: 0 8px 0 12px;
    font-size: var(--text-base);
    white-space: nowrap;
  }
  .problem.error {
    --tone: var(--red);
  }
  .kind {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: var(--weight-semibold);
    color: var(--text);
  }
  .link {
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    font-weight: var(--weight-semibold);
    text-align: left;
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent);
  }
  .reason {
    max-width: 22em;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: var(--weight-semibold);
    color: var(--tone);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .see-all-kinds {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 12px;
    margin: 8px 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .see-all-kinds .see-all {
    margin: 0;
  }
</style>
