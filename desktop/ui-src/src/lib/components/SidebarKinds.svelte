<script lang="ts">
  import type { Category, ResourceKind } from "../bindings";
  import { app, canOpenDenied, deniedReason, kinds, setView } from "../stores/app.svelte";
  import { HELM_VIEW } from "../helm";
  import { HELM_CHARTS_VIEW } from "../helmCharts";
  import { WORKLOADS_VIEW } from "../workloads";
  import { APPLICATIONS_VIEW } from "../applications";
  import { isCrdDefinitions } from "../crd";
  import { PORT_FORWARDS_VIEW } from "../forwards";
  import { forwards, refreshForwards } from "../stores/forwards.svelte";
  import { untrack } from "svelte";
  import { badgeTitle } from "../problems";
  import { problems } from "../stores/problems.svelte";
  import { absentTitle, missingKinds } from "../sidebarExpected";
  import { chart } from "../stores/chart.svelte";
  import { settings, updateSettings } from "../stores/settings.svelte";

  /** The chart's lens: what is typed narrows the kinds (label, kind or short name). */
  const lens = $derived(chart.pinned ? "" : chart.lens.trim().toLowerCase());
  const inLens = (...names: string[]) => !lens || names.some((n) => n.toLowerCase().includes(lens));

  // The count beside Port Forwards: refreshed on start, on Refresh and on a
  // context switch (which stops every forward).
  $effect(() => {
    void app.refreshNonce;
    untrack(refreshForwards);
  });

  /** Sections the user collapsed (#383), remembered in the settings. */
  const collapsed = $derived(new Set(settings.current.collapsed_sections));
  /** While the lens narrows the kinds, every section is open. */
  const isOpen = (id: string) => !!lens || !collapsed.has(id);
  /** A collapsed section still shows the open view, so it is never lost. */
  const shows = (id: string, view: string) => isOpen(id) || app.view === view;

  function toggleSection(id: string) {
    const list = settings.current.collapsed_sections;
    void updateSettings({
      collapsed_sections: list.includes(id) ? list.filter((s) => s !== id) : [...list, id],
    });
  }

  /** The problem count of a collapsed section's kinds: its badges are hidden. */
  function sectionProblems(list: ResourceKind[]): number {
    return list.reduce((n, k) => n + (problems.byKind[k.id]?.count ?? 0), 0);
  }

  const SECTIONS: { category: Category; title: string }[] = [
    { category: "workloads", title: "Workloads" },
    { category: "network", title: "Network" },
    { category: "config", title: "Config" },
    { category: "storage", title: "Storage" },
    { category: "cluster", title: "Cluster" },
    { category: "access", title: "Access Control" },
    { category: "devices", title: "Device Resources" },
  ];

  const byCategory = $derived.by(() => {
    const out = new Map<Category, ResourceKind[]>();
    for (const k of kinds.all) {
      if (!inLens(k.label, k.resource.kind, k.resource.plural, ...k.short_names)) continue;
      const list = out.get(k.category) ?? [];
      list.push(k);
      out.set(k.category, list);
    }
    return out;
  });

  /** Custom resources (and anything unclassified) grouped by API group. */
  function byGroup(category: Category): [string, ResourceKind[]][] {
    const groups = new Map<string, ResourceKind[]>();
    for (const k of byCategory.get(category) ?? []) {
      if (isCrdDefinitions(k.resource)) continue;
      const list = groups.get(k.resource.group) ?? [];
      list.push(k);
      groups.set(k.resource.group, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  const custom = $derived(byGroup("custom"));
  /** The CRDs themselves, first under Custom Resources. */
  const definitions = $derived((byCategory.get("custom") ?? []).filter((k) => isCrdDefinitions(k.resource)));
  const other = $derived(byGroup("other"));

  /** The tooltip of a kind: its full label (it may be cut off) and API identity. */
  function kindTitle(kind: ResourceKind): string {
    const r = kind.resource;
    return `${kind.label}: ${r.kind} (${r.group ? `${r.group}/` : ""}${r.version})`;
  }

  function open(kind: ResourceKind) {
    if (!kinds.denied.has(kind.id) || canOpenDenied(kind)) setView(kind.id);
  }
</script>

{#snippet item(kind: ResourceKind)}
  {@const denied = kinds.denied.has(kind.id)}
  <button
    type="button"
    class="kind"
    class:active={app.view === kind.id}
    class:denied
    aria-disabled={denied && !canOpenDenied(kind)}
    title={denied ? deniedReason(kind) : kindTitle(kind)}
    onclick={() => open(kind)}
    ><span class="label">{kind.label}</span>{#if problems.byKind[kind.id]}{@const b = problems.byKind[kind.id]}{#key b.count}<span
          class="problems"
          class:stale={!b.live}
          data-testid="problem-badge"
          title={badgeTitle(b, kind.label, Date.now())}
          aria-hidden="true">{b.count}</span
        >{/key}{/if}
  </button>
{/snippet}

{#snippet heading(id: string, title: string, list: ResourceKind[] = [])}
  {@const open = isOpen(id)}
  {@const count = open ? 0 : sectionProblems(list)}
  <h4 data-section={id}>
    <button
      type="button"
      class="section"
      aria-expanded={open}
      title={open ? `Collapse ${title}` : `Expand ${title}`}
      onclick={() => toggleSection(id)}
      >{title}{#if count > 0}<span
          class="problems"
          data-testid="section-problems"
          title={`${count} in ${title} need a look`}
          aria-hidden="true">{count}</span
        >{/if}</button
    >
  </h4>
{/snippet}

{#snippet groups(id: string, title: string, list: [string, ResourceKind[]][], first: ResourceKind[] = [])}
  {#if list.length > 0 || first.length > 0}
    {@render heading(id, title, [...first, ...list.flatMap(([, items]) => items)])}
    {#each first as kind (kind.id)}
      {#if shows(id, kind.id)}{@render item(kind)}{/if}
    {/each}
    {#each list as [group, items] (group)}
      {#if isOpen(id)}
        <details open={items.some((k) => k.id === app.view)}>
          <summary title={group}>{group || "core"}</summary>
          {#each items as kind (kind.id)}
            {@render item(kind)}
          {/each}
        </details>
      {:else}
        {#each items.filter((k) => k.id === app.view) as kind (kind.id)}
          {@render item(kind)}
        {/each}
      {/if}
    {/each}
  {/if}
{/snippet}

<!-- The resource groups of the cluster the window shows. -->
<div class="kinds" data-testid="sidebar-kinds">
  {#if inLens("overview")}
    <button type="button" class:active={app.view === "overview"} onclick={() => setView("overview")}>
      Overview
    </button>
  {/if}

  {#each SECTIONS as section (section.category)}
    {@const list = byCategory.get(section.category) ?? []}
    {@const absent = !lens && kinds.loaded && kinds.all.length > 0 ? missingKinds(section.category, kinds.all) : []}
    {#if list.length > 0 || absent.length > 0 || (section.category === "network" && forwards.list.length > 0)}
      {@const id = section.category}
      {@render heading(id, section.title, list)}
      {#if section.category === "workloads" && !lens}
        <!-- Not a kind: counts of every workload kind (#79). -->
        {#if shows(id, WORKLOADS_VIEW)}<button
          type="button"
          class:active={app.view === WORKLOADS_VIEW}
          aria-label="Workloads overview"
          onclick={() => setView(WORKLOADS_VIEW)}>Overview</button
          >{/if}
        <!-- Not a kind: workloads grouped by app labels and Helm release (#226). -->
        {#if shows(id, APPLICATIONS_VIEW)}<button
          type="button"
          class:active={app.view === APPLICATIONS_VIEW}
          onclick={() => setView(APPLICATIONS_VIEW)}>Applications</button
          >{/if}
      {/if}
      {#each list as kind (kind.id)}
        {#if shows(id, kind.id)}{@render item(kind)}{/if}
      {/each}
      <!-- Expected kinds this cluster does not serve, greyed out (#332). -->
      {#each isOpen(id) ? absent : [] as e (e.kind)}
        <button type="button" class="kind absent" aria-disabled="true" title={absentTitle(e)}
          ><span class="label">{e.label}</span></button
        >
      {/each}
      {#if section.category === "network" && inLens("port forwards") && shows(id, PORT_FORWARDS_VIEW)}
        <!-- Not a cluster kind: the forwards this app runs. -->
        <button
          type="button"
          class:active={app.view === PORT_FORWARDS_VIEW}
          onclick={() => setView(PORT_FORWARDS_VIEW)}
        >
          Port Forwards{#if forwards.list.length > 0}<span class="count" aria-hidden="true">{forwards.list.length}</span>{/if}
        </button>
      {/if}
    {/if}
  {/each}

  {#if kinds.loaded && kinds.all.length > 0 && inLens("helm releases", "helm charts")}
    {@render heading("helm", "Helm")}
    {#if shows("helm", HELM_VIEW)}
      <button type="button" class:active={app.view === HELM_VIEW} onclick={() => setView(HELM_VIEW)}>Releases</button>
    {/if}
    {#if shows("helm", HELM_CHARTS_VIEW)}
      <button type="button" class:active={app.view === HELM_CHARTS_VIEW} onclick={() => setView(HELM_CHARTS_VIEW)}
        >Charts</button
      >
    {/if}
  {/if}

  {@render groups("custom", "Custom Resources", custom, definitions)}
  {@render groups("other", "Other", other)}

  {#if !kinds.loaded}
    <p class="muted note">Discovering…</p>
  {/if}
</div>

<style>
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* Section heads: chart labels with a short rule after them. */
  h4 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 4px 0;
    font-family: var(--font-num);
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  h4::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, var(--border), transparent);
  }
  /* A section's head toggles it (#383): a chevron, then the title. */
  button.section {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
  }
  button.section::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 4px solid currentColor;
    border-top: 3.5px solid transparent;
    border-bottom: 3.5px solid transparent;
    transform: rotate(90deg);
    transition: transform 120ms ease;
  }
  button.section[aria-expanded="false"]::before {
    transform: none;
  }
  button.section:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  summary {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  details button {
    padding-left: 24px;
  }
  .note {
    margin: 12px;
    font-size: 12px;
  }
  button {
    position: relative;
    text-align: left;
    background: transparent;
    color: var(--text-muted);
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }
  button:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  /* A kind's button: its label stays inside the sidebar (the full name and
     API identity are in the tooltip); a badge after it stays visible. */
  button.kind {
    display: flex;
    align-items: center;
    /* A button sizes to its content; this keeps it inside the sidebar. */
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
  }
  /* Long names wrap onto a second line; past that they end in an ellipsis. */
  .label {
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    line-height: 1.3;
  }
  .problems {
    flex-shrink: 0;
  }
  /* The open view: a teal beacon on the left edge, lit once on arrival. */
  button.active {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 600;
  }
  button.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 7px;
    bottom: 7px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: beacon 320ms var(--ease-out);
  }
  @keyframes beacon {
    from {
      transform: scaleY(0.2);
      opacity: 0;
    }
  }
  .count {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--bg-hover);
    font-size: 11px;
  }
  /* Objects that need attention, counted from watches already running. */
  .problems {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--red);
    color: var(--bg-sunken);
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 600;
  }
  /* A count that changes pops once, so the eye catches it from afar. */
  .problems {
    animation: pop 420ms var(--ease-out);
  }
  @keyframes pop {
    0% {
      transform: scale(0.5);
    }
    55% {
      transform: scale(1.18);
    }
  }
  /* The count of a watch that has stopped: shown, but not current. */
  .problems.stale {
    background: transparent;
    color: var(--error-text);
    box-shadow: inset 0 0 0 1px var(--red);
    opacity: 0.7;
  }
  button.absent,
  button.denied {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button.absent:hover,
  button.denied:hover {
    background: transparent;
    color: var(--text-muted);
  }
  /* Denied across all namespaces only: opens, to pick a namespace there. */
  button.denied[aria-disabled="false"] {
    cursor: pointer;
  }
</style>
