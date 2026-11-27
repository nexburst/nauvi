<script lang="ts">
  import type { ResourceKind } from "../bindings";
  import { app, canOpenDenied, deniedReason, kinds, setView } from "../stores/app.svelte";
  import { HELM_VIEW } from "../helm";
  import { HELM_CHARTS_VIEW } from "../helmCharts";
  import { WORKLOADS_VIEW } from "../workloads";
  import { APPLICATIONS_VIEW } from "../applications";
  import { IMAGE_SECURITY_VIEW } from "../imageSecurity";
  import { imageSecurityEnabled } from "../stores/imageSecurity.svelte";
  import { currentContextName } from "../stores/app.svelte";
  import { isCrdDefinitions } from "../crd";
  import { PORT_FORWARDS_VIEW } from "../forwards";
  import { forwards, refreshForwards } from "../stores/forwards.svelte";
  import { untrack } from "svelte";
  import { badgeTitle } from "../problems";
  import { problems } from "../stores/problems.svelte";
  import { absentTitle, missingKinds } from "../sidebarExpected";
  import { chart, toggleBerth } from "../stores/chart.svelte";
  import { settings, updateSettings } from "../stores/settings.svelte";
  import { BERTHS_MAX, DEFAULT_BERTHS, pinnable, viewLabel } from "../berths";
  import { kindIcon, viewIcon } from "../kindIcons";
  import { SECTIONS, kindNames, matches, normalizeFilter, splitCommon } from "../sidebarKinds";
  import type { IconName } from "../icons/icons";
  import Icon from "../icons/Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem } from "./ContextMenu.svelte";

  /** The filter (the column's, or the drawer's lens): it narrows the kinds. */
  const lens = $derived(normalizeFilter(chart.lens));

  // The count beside Port Forwards: refreshed on start, on Refresh and on a
  // context switch (which stops every forward).
  $effect(() => {
    void app.refreshNonce;
    untrack(refreshForwards);
  });

  /** One line of the sidebar: a kind, or a view of its own (Helm, Port Forwards...). */
  interface Entry {
    view: string;
    label: string;
    icon: IconName;
    kind?: ResourceKind;
    /** Its accessible name, when the label alone is ambiguous. */
    aria?: string;
    /** A count that is not a problem (running forwards). */
    count?: number;
    /** An expected kind this cluster does not serve (#332). */
    absent?: string;
  }

  const ofKind = (k: ResourceKind): Entry => ({ view: k.id, label: k.label, icon: kindIcon(k), kind: k });
  const ofView = (view: string, label = viewLabel(view, kinds.all), count?: number): Entry => ({
    view,
    label,
    icon: viewIcon(view, kinds.all),
    count,
  });

  /** Sections the user collapsed (#383), remembered in the settings. */
  const collapsed = $derived(new Set(settings.current.collapsed_sections));
  /** Sections whose less-used kinds the user opened (#481). */
  const moreOpen = $derived(new Set(settings.current.open_more_sections ?? []));
  /** While the filter narrows the kinds, every section and its More is open. */
  const isOpen = (id: string) => !!lens || !collapsed.has(id);
  const isMoreOpen = (id: string) => !!lens || moreOpen.has(id);

  function toggleIn(key: "collapsed_sections" | "open_more_sections", id: string) {
    const list = settings.current[key] ?? [];
    void updateSettings({ [key]: list.includes(id) ? list.filter((s) => s !== id) : [...list, id] });
  }

  /** The problem count of entries whose badges are hidden. */
  const problemsOf = (list: Entry[]) => list.reduce((n, e) => n + (problems.byKind[e.view]?.count ?? 0), 0);

  /** A kind or view the filter keeps: by any of its names, or by its section's title. */
  const kept = (title: string, e: Entry) =>
    matches(lens, title) || matches(lens, ...(e.kind ? kindNames(e.kind) : [e.label]));

  interface Section {
    id: string;
    title: string;
    common: Entry[];
    more: Entry[];
  }

  function section(id: string, title: string, common: Entry[], more: Entry[] = []): Section {
    return { id, title, common: common.filter((e) => kept(title, e)), more: more.filter((e) => kept(title, e)) };
  }

  const sections = $derived.by(() => {
    const out: Section[] = [];
    for (const s of SECTIONS) {
      const list = kinds.all.filter((k) => k.category === s.category);
      const { common, more } = splitCommon(s.category, list);
      const absent: Entry[] = (kinds.loaded && kinds.all.length > 0 ? missingKinds(s.category, kinds.all) : []).map(
        (e) => ({ view: `absent:${e.kind}`, label: e.label, icon: "shapes", absent: absentTitle(e) }),
      );
      const head: Entry[] = [];
      const tail: Entry[] = [];
      if (s.category === "workloads" && list.length > 0) {
        // Not kinds: counts of every workload kind (#79), workloads by app (#226).
        head.push({ ...ofView(WORKLOADS_VIEW, "Overview"), aria: "Workloads overview" }, ofView(APPLICATIONS_VIEW));
        // Image security (#534): only where it is on; asks nothing until opened.
        if (imageSecurityEnabled(currentContextName())) head.push(ofView(IMAGE_SECURITY_VIEW));
      }
      if (s.category === "network" && (list.length > 0 || forwards.list.length > 0)) {
        // Not a cluster kind: the forwards this app runs.
        tail.push(ofView(PORT_FORWARDS_VIEW, "Port Forwards", forwards.list.length));
      }
      out.push(
        section(s.category, s.title, [...head, ...common.map(ofKind), ...tail], [...more.map(ofKind), ...absent]),
      );
      if (s.category === "cluster" && kinds.loaded && kinds.all.length > 0) {
        out.push(section("helm", "Helm", [ofView(HELM_VIEW, "Releases"), ofView(HELM_CHARTS_VIEW, "Charts")]));
      }
    }
    return out.filter((s) => s.common.length > 0 || s.more.length > 0);
  });

  /** Custom resources (and anything unclassified) grouped by API group. */
  function byGroup(category: "custom" | "other"): [string, ResourceKind[]][] {
    const groups = new Map<string, ResourceKind[]>();
    for (const k of kinds.all) {
      if (k.category !== category || isCrdDefinitions(k.resource) || !matches(lens, ...kindNames(k), k.resource.group))
        continue;
      const list = groups.get(k.resource.group) ?? [];
      list.push(k);
      groups.set(k.resource.group, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
  const custom = $derived(byGroup("custom"));
  /** The CRDs themselves, first under Custom Resources. */
  const definitions = $derived(
    kinds.all.filter((k) => isCrdDefinitions(k.resource) && matches(lens, "custom resources", ...kindNames(k))),
  );
  const other = $derived(byGroup("other"));

  /** The views kept at hand (the berths, #481): pinned at the top. */
  const known = (view: string) => !view.startsWith("absent:") && viewLabel(view, kinds.all) !== view;
  /**
   * Shown once the user has chosen their own pins: the defaults (Pods,
   * Deployments, Services) would only repeat the entries right below them.
   * The rail shows them either way.
   */
  const ownPins = $derived(
    chart.berths.length !== DEFAULT_BERTHS.length || chart.berths.some((v, i) => v !== DEFAULT_BERTHS[i]),
  );
  const pinned = $derived(
    (ownPins ? chart.berths : [])
      .filter(known)
      .map((v) => {
        const k = kinds.all.find((x) => x.id === v);
        return k ? ofKind(k) : ofView(v);
      })
      .filter((e) => kept("pinned", e)),
  );
  const overview = $derived(matches(lens, "overview", "cluster overview"));

  const nothing = $derived(
    !!lens &&
      kinds.loaded &&
      !overview &&
      pinned.length === 0 &&
      sections.length === 0 &&
      custom.length === 0 &&
      definitions.length === 0 &&
      other.length === 0,
  );

  /** The tooltip of a kind: its full label (it may be cut off) and API identity. */
  function kindTitle(kind: ResourceKind): string {
    const r = kind.resource;
    return `${kind.label}: ${r.kind} (${r.group ? `${r.group}/` : ""}${r.version})`;
  }

  function open(e: Entry) {
    if (e.absent) return;
    if (e.kind && kinds.denied.has(e.kind.id) && !canOpenDenied(e.kind)) return;
    setView(e.view);
  }

  // Right-click on a kind: pin it to the top, or unpin it.
  let menu = $state<{ x: number; y: number; entry: Entry } | null>(null);
  function onMenu(ev: MouseEvent, e: Entry) {
    if (e.absent || !pinnable(e.view)) return;
    ev.preventDefault();
    menu = { x: ev.clientX, y: ev.clientY, entry: e };
  }
  const menuItems = $derived.by((): MenuItem[] => {
    if (!menu) return [];
    const { entry } = menu;
    const items: MenuItem[] = [{ label: "Open", run: () => open(entry) }];
    if (chart.berths.includes(entry.view)) items.push({ label: "Unpin", run: () => toggleBerth(entry.view) });
    else if (chart.berths.length >= BERTHS_MAX)
      items.push({ label: `Pin to top (all ${BERTHS_MAX} pins are taken)`, disabled: true, run: () => {} });
    else items.push({ label: "Pin to top", run: () => toggleBerth(entry.view) });
    return items;
  });
</script>

{#snippet item(e: Entry, opts: { pin?: number; nested?: boolean } = {})}
  {@const denied = !!e.kind && kinds.denied.has(e.kind.id)}
  {@const b = problems.byKind[e.view]}
  <!-- A pinned copy: its section's entry is the one marked as open. -->
  {@const copy = !!opts.pin && e.view !== "overview"}
  <button
    type="button"
    class="kind"
    class:nested={opts.nested}
    class:active={app.view === e.view && !copy}
    class:here={app.view === e.view && copy}
    class:denied
    class:absent={!!e.absent}
    data-view={e.view}
    aria-label={copy ? `${e.aria ?? e.label} (pinned)` : e.aria}
    aria-disabled={!!e.absent || (denied && !canOpenDenied(e.kind!))}
    title={e.absent ?? (denied ? deniedReason(e.kind!) : e.kind ? kindTitle(e.kind) : e.label)}
    onclick={() => open(e)}
    oncontextmenu={(ev) => onMenu(ev, e)}
    ><Icon name={e.icon} size={16} /><span class="label">{e.label}</span
    >{#if b}{#key b.count}<span
          class="problems"
          class:stale={!b.live}
          data-testid="problem-badge"
          title={badgeTitle(b, e.label, Date.now())}
          aria-hidden="true">{b.count}</span
        >{/key}{:else if e.count}<span class="count" aria-hidden="true">{e.count}</span>{/if}{#if opts.pin}<span
        class="key"
        aria-hidden="true">{opts.pin}</span
      >{/if}
  </button>
{/snippet}

{#snippet heading(id: string, title: string, list: Entry[] = [])}
  {@const isopen = isOpen(id)}
  {@const count = isopen ? 0 : problemsOf(list)}
  <h4 data-section={id}>
    <button
      type="button"
      class="section"
      aria-expanded={isopen}
      title={isopen ? `Collapse ${title}` : `Expand ${title}`}
      onclick={() => toggleIn("collapsed_sections", id)}
      ><Icon name="chevronDown" size={12} class="chevron" /><span class="title">{title}</span>{#if count > 0}<span
          class="problems"
          data-testid="section-problems"
          title={`${count} in ${title} need a look`}
          aria-hidden="true">{count}</span
        >{/if}</button
    >
  </h4>
{/snippet}

{#snippet sectionBody(s: Section)}
  {@render heading(s.id, s.title, [...s.common, ...s.more])}
  {#each s.common as e (e.view)}
    {#if isOpen(s.id) || app.view === e.view}{@render item(e)}{/if}
  {/each}
  {#if s.more.length > 0}
    {#if isOpen(s.id) && isMoreOpen(s.id)}
      {#each s.more as e (e.view)}{@render item(e)}{/each}
    {:else}
      <!-- The open view is never hidden away. -->
      {#each s.more.filter((e) => e.view === app.view) as e (e.view)}{@render item(e)}{/each}
    {/if}
    {@const n = s.more.filter((e) => e.view !== app.view || isMoreOpen(s.id)).length}
    {#if isOpen(s.id) && !lens && n > 0}
      {@const hidden = isMoreOpen(s.id) ? 0 : problemsOf(s.more.filter((e) => e.view !== app.view))}
      <button
        type="button"
        class="more"
        aria-expanded={isMoreOpen(s.id)}
        data-testid="sidebar-more"
        data-section={s.id}
        title={isMoreOpen(s.id) ? `Show only the common kinds of ${s.title}` : `Show every kind of ${s.title}`}
        onclick={() => toggleIn("open_more_sections", s.id)}
        ><span class="more-label">{isMoreOpen(s.id) ? "Fewer" : `${n} more`}</span>{#if hidden > 0}<span
            class="problems"
            aria-hidden="true">{hidden}</span
          >{/if}</button
      >
    {/if}
  {/if}
{/snippet}

{#snippet groups(id: string, title: string, list: [string, ResourceKind[]][], first: ResourceKind[] = [])}
  {#if list.length > 0 || first.length > 0}
    {@render heading(id, title, [...first, ...list.flatMap(([, items]) => items)].map(ofKind))}
    {#each first as kind (kind.id)}
      {#if isOpen(id) || app.view === kind.id}{@render item(ofKind(kind))}{/if}
    {/each}
    {#each list as [group, items] (group)}
      {#if isOpen(id)}
        <details open={!!lens || items.some((k) => k.id === app.view)}>
          <summary title={group}><Icon name="chevronRight" size={12} class="chevron" />{group || "core"}</summary>
          {#each items as kind (kind.id)}
            {@render item(ofKind(kind), { nested: true })}
          {/each}
        </details>
      {:else}
        {#each items.filter((k) => k.id === app.view) as kind (kind.id)}
          {@render item(ofKind(kind))}
        {/each}
      {/if}
    {/each}
  {/if}
{/snippet}

<!-- The kinds of the cluster the window shows: the Overview and what is
     pinned, then each section's common kinds, the rest under "More". -->
<div class="kinds" data-testid="sidebar-kinds">
  {#if overview}
    {@render item(ofView("overview"))}
  {/if}

  {#if pinned.length > 0}
    <div class="pinned" data-testid="sidebar-pinned">
      {@render heading("pinned", "Pinned", pinned)}
      {#each pinned as e (e.view)}
        {#if isOpen("pinned") || app.view === e.view}{@render item(e, { pin: chart.berths.indexOf(e.view) + 2 })}{/if}
      {/each}
    </div>
  {/if}

  {#each sections as s (s.id)}
    <div class="group" data-group={s.id}>{@render sectionBody(s)}</div>
  {/each}

  {#if custom.length > 0 || definitions.length > 0}
    <div class="group" data-group="custom">{@render groups("custom", "Custom Resources", custom, definitions)}</div>
  {/if}
  {#if other.length > 0}
    <div class="group" data-group="other">{@render groups("other", "Other", other)}</div>
  {/if}

  {#if nothing}
    <p class="muted note" data-testid="sidebar-no-match">No kind matches “{chart.lens.trim()}”.</p>
  {/if}
  {#if !kinds.loaded}
    <p class="muted note">Discovering…</p>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} title={menu.entry.label} items={menuItems} onclose={() => (menu = null)} />
{/if}

<style>
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .group,
  .pinned {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  /* Section heads: a word in the UI font, sentence case, with a chevron
     that turns when the section is closed (#383, #481). */
  h4 {
    margin: 6px 0 1px;
    font: inherit;
  }
  button.section {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 8px 3px 6px;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-muted);
  }
  button.section .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.section :global(.chevron),
  summary :global(.chevron) {
    opacity: 0.7;
    transition: transform 140ms var(--ease-out);
  }
  button.section[aria-expanded="false"] :global(.chevron) {
    transform: rotate(-90deg);
  }
  details[open] > summary :global(.chevron) {
    transform: rotate(90deg);
  }
  button.section:hover {
    background: transparent;
    color: var(--text);
  }
  button.section:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px 5px 10px;
    font-size: var(--text-sm);
    color: var(--text-muted);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    list-style: none;
    border-radius: 6px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .note {
    margin: 12px 8px;
    font-size: var(--text-sm);
  }
  button {
    position: relative;
    text-align: left;
    background: transparent;
    color: var(--text-muted);
    border: none;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: var(--text-base);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }
  button:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  /* A kind: its icon, its name (whole in the tooltip), then its badge. */
  button.kind {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-width: 0;
    color: var(--text);
  }
  button.kind :global(.icon) {
    color: var(--text-muted);
  }
  button.kind.nested {
    padding-left: 22px;
  }
  /* Long names wrap onto a second line; past that they end in an ellipsis
     (the full name is in the tooltip). */
  .label {
    flex: 1;
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    line-height: 18px;
  }
  /* The key that opens a pinned view (1-9): shown on hover or focus. */
  .key {
    flex-shrink: 0;
    min-width: 10px;
    font-family: var(--font-num);
    font-size: var(--text-xs);
    color: var(--text-muted);
    opacity: 0;
    text-align: right;
    transition: opacity 120ms ease;
  }
  button.kind:hover .key,
  button.kind:focus-visible .key {
    opacity: 0.7;
  }
  /* "N more" / "Fewer": quieter than a kind, in line with the labels. */
  button.more {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 33px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  button.more .more-label {
    flex: 1;
  }
  /* The open view: tinted, its icon in the accent, a bar on the left edge. */
  button.active {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: var(--weight-semibold);
  }
  button.kind.active :global(.icon),
  button.kind.here :global(.icon) {
    color: var(--accent);
  }
  /* A pinned copy of the open view: its section's entry carries the mark. */
  button.kind.here {
    font-weight: var(--weight-semibold);
  }
  button.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
    animation: beacon 320ms var(--ease-out);
  }
  @keyframes beacon {
    from {
      transform: scaleY(0.2);
      opacity: 0;
    }
  }
  .count {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--bg-hover);
    font-family: var(--font-num);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  /* Objects that need attention, counted from watches already running. */
  .problems {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--red);
    color: var(--bg-sunken);
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 600;
    line-height: 16px;
    /* A count that changes pops once, so the eye catches it from afar. */
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
  }
  /* Denied across all namespaces only: opens, to pick a namespace there. */
  button.denied[aria-disabled="false"] {
    cursor: pointer;
  }
</style>
