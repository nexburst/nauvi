<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import UsageChart from "./UsageChart.svelte";
  import type { MetricsKind } from "../bindings";
  import { formatCpu, formatMemory } from "../format";
  import { UsageFeed } from "../stores/usage.svelte";
  import { fallbackNote, refLines, USAGE_RANGES, usageSourceText } from "../usage";
  import type { ChartLine } from "../usage";

  /** CPU and memory charts of a pod or node (#47), or of all the pods of a
   *  workload (`workload`: its kind, #79), from the usage history the
   *  backend keeps while metrics are on screen, or from Prometheus over
   *  1h, 6h or 24h when the context has one. Pods also show each
   *  container, nodes their allocatable, workloads their pods' summed
   *  requests and limits. */
  let {
    what = "pods",
    workload = "",
    namespace,
    name,
  }: { what?: MetricsKind; workload?: string; namespace: string | null; name: string } = $props();

  // The panel is remounted for every object, so the props are fixed here.
  // svelte-ignore state_referenced_locally
  const feed = new UsageFeed(workload ? { workload, namespace: namespace ?? "", name } : { what, namespace, name });
  // svelte-ignore state_referenced_locally
  const subject = workload ? `the pods of this ${workload}` : what === "pods" ? "this pod" : "this node";
  onMount(() => feed.start());
  onDestroy(() => feed.stop());

  const data = $derived(feed.data);
  const note = $derived(data ? fallbackNote(data) : "");
  const lines = $derived.by((): ChartLine[] => {
    const h = data?.history;
    if (!h) return [];
    const total = { name: workload ? "pods" : what === "pods" ? "pod" : "node", samples: h.samples };
    // One container is the pod itself; more get a line each.
    return h.containers.length > 1 ? [total, ...h.containers] : [total];
  });
</script>

<section class="usage" data-testid="usage-charts">
  <div class="head">
    <h3>Usage</h3>
    {#if data?.prometheus}
      <div class="ranges" role="group" aria-label="Usage range">
        {#each USAGE_RANGES as r (r.value)}
          <button
            type="button"
            class="range"
            class:active={feed.range === r.value}
            aria-pressed={feed.range === r.value}
            onclick={() => feed.setRange(r.value)}>{r.label}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if note}
    <p class="muted small note" data-testid="usage-note" title={note}>{note}</p>
  {/if}
  {#if !data}
    <p class="muted small">{feed.error ? `Could not load usage: ${feed.error}` : "Loading…"}</p>
  {:else if data.history.samples.length === 0}
    <p class="muted small note" data-testid="usage-empty">
      No usage yet. metrics-server has no sample for {subject}, or is not installed.
    </p>
  {:else}
    <p class="muted small" data-testid={data.source === "prometheus" ? "usage-source" : "usage-since"}>
      {usageSourceText(data)}
    </p>
    <UsageChart title="CPU" resource="cpu" {lines} refs={refLines(data.reference, "cpu")} format={formatCpu} />
    <UsageChart
      title="Memory"
      resource="memory"
      {lines}
      refs={refLines(data.reference, "memory")}
      format={formatMemory}
    />
  {/if}
</section>

<style>
  /* One line: where the numbers come from. The whole of it is the tooltip,
     and it opens in place under the pointer. */
  .note {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    overflow: hidden;
  }
  .note:hover {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
  .ranges {
    display: flex;
    gap: 2px;
  }
  .range {
    font-size: 11px;
    padding: 1px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .range.active {
    color: var(--text);
    border-color: var(--accent);
  }
  .small {
    font-size: 12px;
    margin: 0 0 8px;
  }
</style>
