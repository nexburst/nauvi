<script lang="ts">
  import { untrack } from "svelte";
  import { chart } from "../stores/chart.svelte";
  import { onDestroy, onMount } from "svelte";
  import ActionBar from "./ActionBar.svelte";
  import ConditionsTable from "./ConditionsTable.svelte";
  import DetailNotices from "./DetailNotices.svelte";
  import EventsTable from "./EventsTable.svelte";
  import KeyValueData from "./KeyValueData.svelte";
  import KindSummary from "./KindSummary.svelte";
  import MetaSection from "./MetaSection.svelte";
  import RelatedGroups from "./RelatedGroups.svelte";
  import YamlEditor from "./YamlEditor.svelte";
  import ServicePorts from "./ServicePorts.svelte";
  import UsageCharts from "./UsageCharts.svelte";
  import { isWorkloadResource } from "../dock";
  import { crdInstancesKind, isCrdDefinitions } from "../crd";
  import { kinds, setView } from "../stores/app.svelte";
  import { closeDetail } from "../stores/detail.svelte";
  import { registerTabs } from "../stores/keyboard.svelte";
  import type { Target } from "../stores/detail.svelte";
  import { LiveDetail } from "../stores/live-detail.svelte";
  import { LiveRelated } from "../stores/related.svelte";

  /** Detail panel for any kind without a dedicated one (pods have their own). */
  let { target }: { target: Target } = $props();

  // The panel is remounted for every object, so `target` is fixed here.
  // svelte-ignore state_referenced_locally
  const live = new LiveDetail(target);
  const info = $derived(live.info);
  // svelte-ignore state_referenced_locally
  const related = new LiveRelated(target);
  /** Kinds without related objects (a CRD, a Lease) show none of it. */
  const hasRelated = $derived.by(() => {
    const d = related.data;
    return !!d && (d.summary.length > 0 || d.facts.length > 0 || d.groups.length > 0);
  });
  // Reload the related objects when the live detail reports a change.
  $effect(() => {
    if (live.info) related.seen(live.info);
  });

  /** Workloads get usage charts of all their pods (and Logs in the header). */
  const isWorkload = $derived(isWorkloadResource(target.resource));
  /** Secrets and ConfigMaps get the key/value data editor (#224). */
  const hasData = $derived(
    target.resource.group === "" && (target.resource.kind === "Secret" || target.resource.kind === "ConfigMap"),
  );
  /** A CRD gets a button to the table of its instances. */
  const instances = $derived(isCrdDefinitions(target.resource) ? crdInstancesKind(kinds.all, target.name) : undefined);
  const tabs = $derived([
    { id: "overview", label: "Overview" },
    { id: "yaml", label: "YAML" },
  ]);
  let tab = $state("overview");
  // YAML wants the room: it takes the sheet (W gives the table back).
  $effect(() => {
    if (tab === "yaml" && !chart.pinned) untrack(() => (chart.wide = true));
  });

  onMount(() => {
    void live.start();
    void related.refresh();
  });
  onDestroy(() => {
    live.stop();
    related.stop();
  });
  // Ctrl/Cmd+1…9 picks a tab.
  onMount(() => registerTabs({ count: () => tabs.length, select: (i) => (tab = tabs[i].id) }));
</script>

<aside data-testid="detail-panel">
  <div class="top">
    <div class="header">
      <!-- A long title breaks after the namespace's slash first (#384). -->
      <span class="title"
        ><span class="muted">{target.resource.kind}</span>
        {#if target.namespace}{target.namespace}/<wbr />{/if}{target.name}</span
      >
      <button type="button" class="close" aria-label="Close details" onclick={closeDetail}>✕</button>
    </div>
    <ActionBar {target} disabled={live.deleted} onEdit={() => (tab = "yaml")} />
  </div>
  <DetailNotices {live} kind={target.resource.kind} />

  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === t.id}
        class:active={tab === t.id}
        onclick={() => (tab = t.id)}>{t.label}</button
      >
    {/each}
    {#if instances}
      {@const to = instances}
      <button
        type="button"
        class="btn instances"
        title={`Opens the table of ${to.label}`}
        onclick={() => setView(to.id)}>View instances</button
      >
    {/if}
  </div>

  {#if tab === "overview"}
    <div class="body">
      {#if live.deleted && !info}
        <!-- DetailNotices says it was deleted. -->
      {:else if live.loadError && !info}
        <p class="error-text">Could not load details: {live.loadError}</p>
      {:else if !info}
        <p class="muted">Loading…</p>
      {:else}
        {#if hasRelated}<KindSummary {related} />{/if}
        <MetaSection {info} />
        {#if target.resource.group === "" && target.resource.kind === "Node"}
          <UsageCharts what="nodes" namespace={null} name={target.name} />
        {:else if isWorkload}
          <!-- All its pods, summed (#79). -->
          <UsageCharts workload={target.resource.kind} namespace={target.namespace} name={target.name} />
        {/if}
        {#if target.resource.group === "" && target.resource.kind === "Service"}
          <ServicePorts namespace={target.namespace} name={target.name} disabled={live.deleted} />
        {/if}

        {#if hasData}
          <KeyValueData {target} disabled={live.deleted} />
        {/if}

        <RelatedGroups {related} />
        <ConditionsTable conditions={info.conditions} />
        <EventsTable events={info.events} />
      {/if}
    </div>
  {:else if tab === "yaml"}
    <YamlEditor {target} />
  {/if}
</aside>

<style>
  aside {
    width: min(var(--detail-width, 520px), 75vw);
    flex-shrink: 0;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  aside > :global(*) {
    flex-shrink: 0;
  }
  /* The title and the actions stay in view while the panel scrolls. */
  .top {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px 2px;
    font-weight: 600;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: none;
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .close:hover {
    color: var(--text);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button[role="tab"] {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 8px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .tabs button[role="tab"].active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .tabs .instances {
    margin: 4px 0 4px auto;
    align-self: center;
  }
  .body {
    padding: 12px 16px;
  }
</style>
