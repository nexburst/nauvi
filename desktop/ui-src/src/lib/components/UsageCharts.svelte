<script lang="ts">
  import type { MetricsKind } from "../bindings";
  import { metricsHidden } from "../stores/metricsHidden.svelte";
  import MetricsHiddenNote from "./MetricsHiddenNote.svelte";
  import UsageChartsLive from "./UsageChartsLive.svelte";

  /** The usage charts of a detail panel, or a note when metrics are hidden
   *  for the cluster (#327). Hiding them unmounts the charts, which stops
   *  their polling. */
  let props: { what?: MetricsKind; workload?: string; namespace: string | null; name: string } = $props();
</script>

{#if metricsHidden()}
  <section class="usage" data-testid="usage-charts">
    <h3>Usage</h3>
    <MetricsHiddenNote inline />
  </section>
{:else}
  <UsageChartsLive {...props} />
{/if}

<style>
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
</style>
