<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { Capacity, OverviewUsageView, UsageSample } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import { clusterChart, clusterRefs, recordClusterUsage } from "../clusterUsage";
  import { formatCpu, formatMemory } from "../format";
  import UsageChart from "./UsageChart.svelte";

  /** The overview's 1-hour CPU and memory chart (#328). Only mounted while
   *  metrics are shown for the cluster (#327): unmounting stops the polling. */
  let { capacity, context }: { capacity: Capacity; context: string } = $props();

  /** Prometheus answers for the last hour; asking again this often keeps it current. */
  const POLL_MS = 60_000;
  /** The charts show from this many samples on. */
  const MIN_SAMPLES = 3;

  let view = $state.raw<OverviewUsageView | null>(null);
  let local = $state.raw<readonly UsageSample[]>([]);

  // Every summary with usage adds a sample (at most one per 15 s).
  $effect(() => {
    local = recordClusterUsage(context, capacity);
  });

  /** Bumped per context, so an answer for the previous one is dropped. */
  let round = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function poll(r: number) {
    try {
      const v = await api(visibleCluster()).cmdOverviewUsage();
      if (r === round) view = v;
    } catch {
      // Best effort: the metrics-server samples stay.
    }
    if (r === round) timer = setTimeout(() => poll(r), POLL_MS);
  }

  $effect(() => {
    void context;
    const r = ++round;
    view = null;
    if (timer) clearTimeout(timer);
    untrack(() => void poll(r));
  });

  onDestroy(() => {
    round++;
    if (timer) clearTimeout(timer);
  });

  const chart = $derived(clusterChart(view, local));
  const lines = $derived([{ name: "used", samples: chart.samples }]);
</script>

{#if chart.samples.length > 0 || capacity.metrics}
  <section class="usage" aria-label="Usage, last hour" data-testid="overview-usage">
    <p class="muted small source" data-testid="overview-usage-source">{chart.source}</p>
    {#if chart.note}
      <p class="muted small note" data-testid="overview-usage-note">{chart.note}</p>
    {/if}
    {#if chart.samples.length < MIN_SAMPLES}
      <!-- Two points draw no trend: wait for a third (#605). -->
      <p class="muted small note" data-testid="overview-usage-collecting">Collecting usage, first points in about a minute.</p>
    {:else}
      <div class="charts">
        <UsageChart title="CPU" resource="cpu" {lines} refs={clusterRefs(capacity, "cpu")} format={formatCpu} />
        <UsageChart
          title="Memory"
          resource="memory"
          {lines}
          refs={clusterRefs(capacity, "memory")}
          format={formatMemory}
        />
      </div>
    {/if}
  </section>
{/if}

<style>
  .usage {
    margin-top: 12px;
  }
  .small {
    font-size: 12px;
  }
  .source,
  .note {
    margin: 0 0 6px;
  }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
</style>
