<script lang="ts">
  import { onDestroy } from "svelte";
  import { runningShort, runningText } from "../hidden";
  import { app, currentContextName } from "../stores/app.svelte";
  import { contextLabel } from "../stores/catalog.svelte";
  import { tree } from "../stores/clusters.svelte";
  import { pollWindowForwards, windowItems } from "../stores/hidden.svelte";
  import { settings } from "../stores/settings.svelte";
  import { hhmmss, zoneSuffix } from "../timeZone";
  import { statusTimeLabel } from "../statusTime";
  import { loadServerVersion, versions } from "../stores/serverVersion.svelte";
  import ClusterLabel from "./ClusterLabel.svelte";
  import WakeLine from "./WakeLine.svelte";

  const zone = $derived(settings.current.time_zone);
  const visible = $derived(currentContextName());
  // The cluster's Kubernetes version next to its name (#387), asked on
  // each switch: the backend keeps it per connection.
  const version = $derived(versions.byId.get(visible) ?? "");
  $effect(() => {
    void loadServerVersion(visible);
  });
  // What the time means depends on the view's state (lib/statusTime.ts).
  const timeLabel = $derived(
    statusTimeLabel(app.status, app.updatedAt, (ms) => `${hhmmss(ms, zone)}${zoneSuffix(zone)}`),
  );

  // What runs on the other clusters of this window (ADR 0007), each with
  // its cluster's label: their forwards and tabs keep running unseen.
  const others = $derived([...windowItems.byCluster.entries()].filter(([id]) => id !== visible));

  // The forwards are polled only while the window is connected to another
  // cluster than the one it shows (or the last poll found some).
  const background = $derived(
    [...tree.nodes.entries()].some(([id, n]) => id !== visible && n.state === "connected") ||
      windowItems.forwards.some((f) => f.cluster !== visible),
  );
  let stop: (() => void) | null = null;
  $effect(() => {
    if (background && !stop) stop = pollWindowForwards();
    else if (!background && stop) {
      stop();
      stop = null;
    }
  });
  onDestroy(() => stop?.());
</script>

<footer>
  {#if visible}
    <span class="here" data-testid="status-cluster"><ClusterLabel id={visible} title={`Shown: ${contextLabel(visible)}`} /></span>
    {#if version}<span class="version" data-testid="status-version" title="Kubernetes version of the cluster">{version}</span>{/if}
  {/if}
  <span>{app.count}</span>
  <!-- Before the time, so the footer's text still ends with it. -->
  <WakeLine />
  <span class:stale={app.status.ok === false} data-testid="status-time">{timeLabel}</span>{#if others.length}
    <span class="others" data-testid="status-background">
      <span class="muted-label">Also running:</span>
      {#each others as [id, r] (id)}
        <span class="other" data-testid="status-background-cluster" data-cluster={id}>
          <ClusterLabel {id} title={`${runningText(r)} on ${contextLabel(id)}, not shown in this window`} />
          <span class="what">{runningShort(r)}</span>
        </span>
      {/each}
    </span>
  {/if}</footer
>

<style>
  footer {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-muted);
    font-family: var(--font-num);
    font-size: 11px;
    flex-shrink: 0;
    min-width: 0;
    white-space: nowrap;
  }
  .stale {
    color: var(--amber);
  }
  /* Close to the name it belongs to. */
  .version {
    margin-left: -10px;
    flex-shrink: 0;
  }
  .here {
    display: inline-flex;
    max-width: 200px;
    color: var(--text);
  }
  .others {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
  }
  .other {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 240px;
    min-width: 0;
    padding: 0 6px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text);
  }
  .what {
    color: var(--text-muted);
    flex-shrink: 0;
  }
</style>
