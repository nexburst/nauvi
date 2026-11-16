<script lang="ts">
  import { onMount } from "svelte";
  import { commands } from "../../bindings";
  import type { ActionAccess, MetricsAddonId } from "../../bindings";
  import { loadAddons, openMetricsInstall } from "../../stores/metricsInstall.svelte";

  /**
   * "Install metrics-server…" (or Prometheus) where the app finds no
   * metrics: opens the install dialog, which does nothing before its dry
   * run and confirm. Greyed, with the reason, when RBAC would refuse the
   * cluster-scoped objects the chart creates.
   */
  let {
    addon,
    label,
    text,
    onopen,
  }: { addon: MetricsAddonId; label: string; text: string; onopen?: () => void } = $props();

  let access = $state.raw<ActionAccess | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const a = (await loadAddons()).find((x) => x.id === addon);
        if (a) access = await commands.cmdMetricsAddonAccess(addon, a.namespace);
      } catch {
        // Unknown: the dialog checks again, and the dry run asks the API server.
      }
    })();
  });

  const denied = $derived(access && !access.allowed ? access.reason : "");

  function open() {
    onopen?.();
    openMetricsInstall(addon);
  }
</script>

<div class="offer" data-testid="metrics-offer-{addon}">
  <span class="muted">{text}</span>
  <button type="button" class="btn" disabled={!!denied} title={denied || undefined} onclick={open}>{label}</button>
  {#if denied}<span class="denied muted" data-testid="metrics-offer-denied">{denied}</span>{/if}
</div>

<style>
  .offer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    font-size: 12px;
  }
  .denied {
    flex-basis: 100%;
    font-size: 12px;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
