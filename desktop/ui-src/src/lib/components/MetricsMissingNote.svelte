<script lang="ts">
  import MetricsOffer from "./helm/MetricsOffer.svelte";

  /** Above the Pods and Nodes tables when the cluster serves no metrics
   *  API (#485): why CPU and memory are empty, and how to fix it. */
</script>

<div class="note" data-testid="metrics-missing">
  <MetricsOffer
    addon="metrics-server"
    label="Install metrics-server…"
    text="CPU and memory are empty: this cluster has no metrics API (metrics-server)."
  />
</div>

<style>
  .note {
    padding: 6px 16px;
    border-bottom: 1px solid var(--border);
  }
</style>
