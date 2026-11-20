<script lang="ts">
  import CalmWater from "./CalmWater.svelte";
  import { chart } from "../stores/chart.svelte";
  import { visibleRows } from "../stores/visibleRows.svelte";
  import { app, kinds, openObject, switchNamespace } from "../stores/app.svelte";
  import { cellLink, type CellLink } from "../cellLinks";
  import { rowHeightPx } from "../preferences";
  import { onMount } from "svelte";
  import VirtualList from "./VirtualList.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import Sparkline from "./Sparkline.svelte";
  import ContainerSquares from "./ContainerSquares.svelte";
  import RolloutStatus from "./RolloutStatus.svelte";
  import { clockTime } from "../usage";
  import { watchGutter } from "../scrollGutter";
  import type { MenuItem } from "./ContextMenu.svelte";
  import { replicasFromRow } from "../actions";
  import { rangeKeys } from "../selection";
  import { requestAction, setNotice } from "../stores/actions.svelte";
  import { deleteDenied, deniedActions, namespacesOf } from "../access";
  import { visibleCluster } from "../cluster";
  import { dockMenuFor } from "../dock";
  import { openDockTab } from "../stores/dock.svelte";
  import { copyLink, prefetchLink } from "../stores/links.svelte";
  import { registerTable } from "../stores/keyboard.svelte";
  import type { RowMove } from "../stores/keyboard.svelte";
  import type { ResourceKind } from "../bindings";
  import { columnsFor, minColumnsWidth, shownColumns } from "../columns";
  import type { Metrics, Row } from "../columns";
  import type { KeyedStore } from "../stores/keyed.svelte";
  import type { Sort } from "../view";
  import { ListFilter } from "../stores/tableFilter.svelte";
  import { rawHay } from "../tableFilter";
  import { sortOf, withSort } from "../settings";
  import { kindSettings, settings, updateSettings } from "../stores/settings.svelte";
  import { registerTableExport } from "../stores/tableExport.svelte";
  import { tableCsv } from "../csv";

  interface Props {
    kind: ResourceKind;
    store: KeyedStore<Row>;
    metrics: Metrics;
    now: number;
    /** Only rows of this `ResourceRow.status` ("" = all). */
    status?: string;
    /** Key of the highlighted row, if any. */
    selectedKey?: string | null;
    onselect?: (row: Row) => void;
    /** Called with (shown, total) whenever either changes. */
    oncount?: (shown: number, total: number) => void;
    scrollEl?: HTMLDivElement | null;
  }

  let {
    kind,
    store,
    metrics,
    now,
    status = "",
    selectedKey = null,
    onselect,
    oncount,
    scrollEl = $bindable(null),
  }: Props = $props();

  // Settings → Tables (#330): normal or compact.
  const ROW_HEIGHT = $derived(rowHeightPx(28, settings.current.row_height));

  // The header leaves the width of the scroller's scrollbar, so its columns
  // stay over the cells: 15 px in Chromium, 0 with WebKitGTK's overlay
  // scrollbars (#140).
  let gutter = $state(0);
  $effect(() => {
    if (scrollEl) return watchGutter(scrollEl, (px) => (gutter = px));
  });

  // The columns the user has not hidden (column chooser in the toolbar),
  // and the sort, both remembered per kind.
  const hidden = $derived(kindSettings(kind.id).hidden);
  const shownExtra = $derived(kindSettings(kind.id).shown ?? []);
  const columns = $derived(shownColumns(columnsFor(kind), hidden, metrics, shownExtra));
  // The checkbox, the columns, then the row's ⋮ menu (#382).
  const MORE_PX = 28;
  const template = $derived(["32px", ...columns.map((c) => c.width), `${MORE_PX}px`].join(" "));
  // Columns that don't fit (extra ones turned on, the detail panel open)
  // scroll sideways, the header with the rows, instead of being cut off.
  const minWidth = $derived(32 + minColumnsWidth(columns) + MORE_PX);
  let scrollLeft = $state(0);
  // svelte-ignore state_referenced_locally
  let sort = $state.raw<Sort | null>(sortOf(kindSettings(kind.id)));

  // Re-evaluated when the rows, the filter, the sort, or (only when sorting by
  // a metric / age column) the metrics or clock change.
  // The toolbar filter (#219): text, match case or a regex in the worker.
  const filter = new ListFilter(() => store.entries, {
    key: (e) => e.key,
    lower: (e) => e.hay,
    text: (e) => rawHay(e.row),
  });
  // The clock is read untracked there: an age tick redraws the Age cells only.
  const rows = visibleRows(
    () => ({ entries: store.entries, match: filter.match, sort, columns, metrics, status }),
    () => now,
  );
  const visible = $derived(rows.value);
  const getKey = $derived((i: number) => visible[i]?.key ?? i);

  $effect(() => {
    oncount?.(visible.length, store.entries.length);
  });

  // What the open object's row says is wrong: the inspector leads with it.
  // ponytail: a scan of the rows per update, only while an object is open;
  // a keyed lookup if tables of many thousands make it show.
  $effect(() => {
    const row = selectedKey ? store.entries.find((e) => e.key === selectedKey)?.row : undefined;
    // With how often it restarted, when the table has that column.
    const at = columns.findIndex((c) => c.key === "restarts");
    const restarts = row && at >= 0 ? Number(columns[at].text(row, { metrics, now: 0 })) : 0;
    chart.verdict = row?.problem ? `${row.problem}${restarts > 0 ? ` · ${restarts} restart${restarts === 1 ? "" : "s"}` : ""}` : "";
  });

  // Multi-select. Only rows that are on screen can stay selected, so what a
  // bulk action names is always what the user can see.
  let selected = $state.raw(new Set<string>());
  let anchor = $state<string | null>(null);
  const visibleKeys = $derived(visible.map((e) => e.key));
  const allSelected = $derived(visible.length > 0 && visible.every((e) => selected.has(e.key)));
  const someSelected = $derived(selected.size > 0 && !allSelected);
  const deleteAction = $derived(kind.actions.find((a) => a.id === "delete"));

  $effect(() => {
    const keys = new Set(visibleKeys);
    if ([...selected].some((k) => !keys.has(k))) {
      selected = new Set([...selected].filter((k) => keys.has(k)));
    }
  });

  function toggleRow(key: string, shift: boolean) {
    const next = new Set(selected);
    if (shift && anchor !== null) {
      const on = !selected.has(key);
      for (const k of rangeKeys(visibleKeys, anchor, key)) {
        if (on) next.add(k);
        else next.delete(k);
      }
    } else if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
    anchor = key;
  }

  function toggleAll() {
    selected = allSelected ? new Set() : new Set(visibleKeys);
    anchor = null;
  }

  const targetsOf = (keys: Set<string>) =>
    visible.filter((e) => keys.has(e.key)).map((e) => ({ namespace: e.row.namespace, name: e.row.name }));

  function deleteSelected() {
    if (bulkDenied) return;
    if (deleteAction) requestAction(kind, targetsOf(selected), deleteAction);
  }

  // The cluster these rows are of. A link or menu acts only while it is still
  // the one on screen (#382): a click that lands during a cluster switch
  // must not open a namespace or object in the other cluster.
  const ownCluster = visibleCluster();
  const stillOwnCluster = () => visibleCluster() === ownCluster;

  function followLink(link: CellLink) {
    if (!stillOwnCluster()) return;
    if (link.to === "namespace") switchNamespace(link.namespace);
    else openObject(link.kind, link.namespace, link.name);
  }

  // A cell link follows a click, with or without Ctrl/Cmd/Shift (no new
  // window, no row selection); a middle click does nothing at all.
  function follow(e: MouseEvent, link: CellLink) {
    e.stopPropagation();
    followLink(link);
  }
  function noMiddle(e: MouseEvent) {
    if (e.button === 1) e.preventDefault();
  }
  function swallow(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  // The row's ⋮ button: the same menu as a right-click, under the button.
  function openMenuFromButton(e: MouseEvent, row: Row) {
    e.stopPropagation();
    focusedKey = row.key;
    // The grid keeps the keyboard; the menu gives the focus back to it.
    gridEl?.focus({ preventScroll: true });
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.right, r.bottom, row);
  }

  // Right-click menu, built from the same registry as the detail panels.
  let menu = $state.raw<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);

  function openMenu(e: MouseEvent, row: Row) {
    e.preventDefault();
    focusedKey = row.key;
    openMenuAt(e.clientX, e.clientY, row);
  }

  function openMenuAt(x: number, y: number, row: Row) {
    if (!stillOwnCluster()) return;
    let items: (MenuItem & { id?: string })[];
    let title: string;
    if (selected.has(row.key) && selected.size > 1) {
      title = `${selected.size} selected`;
      items = deleteAction
        ? [{ label: `Delete ${selected.size} selected…`, danger: true, reason: bulkDenied, run: deleteSelected }]
        : [];
    } else {
      title = row.namespace ? `${row.namespace}/${row.name}` : row.name;
      const keys = kind.columns.map((c) => c.key);
      prefetchLink(kind.resource, row.namespace, row.name);
      // Logs and Shell open dock tabs; the rest come from the action registry.
      items = [
        ...dockMenuFor(kind.resource, row.namespace, row.name).map((d) => ({
          id: d.label === "Shell" ? "shell" : "logs",
          label: d.label,
          run: () => openDockTab(d.spec),
        })),
        // A nauvi:// link to the object (#299).
        { label: "Copy link", run: () => void copyLink(kind.resource, row.namespace, row.name) },
        ...kind.actions.map((a) => ({
          id: a.id,
          label: a.label,
          danger: a.destructive,
          run: () =>
            requestAction(kind, [{ namespace: row.namespace, name: row.name }], a, replicasFromRow(row, keys)),
        })),
      ];
      greyDenied(row.namespace, items);
    }
    menu = items.length > 0 ? { x, y, title, items } : null;
  }

  // RBAC (#340): grey out the menu's actions the user may not run, once
  // the access check answers (cached in the backend, so usually at once).
  let menuCheck = 0;
  function greyDenied(namespace: string, items: (MenuItem & { id?: string })[]) {
    const token = ++menuCheck;
    const ids = items.flatMap((i) => (i.id ? [i.id] : []));
    void deniedActions(kind.resource, namespace, ids).then((reasons) => {
      if (token !== menuCheck || !menu || reasons.size === 0) return;
      menu = { ...menu, items: items.map((i) => (i.id && reasons.has(i.id) ? { ...i, reason: reasons.get(i.id) } : i)) };
    });
  }

  // The bulk bar's Delete: refused when any namespace of the selection
  // refuses it.
  let bulkDenied = $state("");
  // As one string, so watch batches that keep the namespaces don't re-ask.
  const selectedNamespaces = $derived(selected.size > 0 ? namespacesOf(targetsOf(selected)).join("\n") : null);
  $effect(() => {
    const id = deleteAction?.id;
    const namespaces = selectedNamespaces !== null && id ? selectedNamespaces.split("\n") : [];
    let live = true;
    void deleteDenied(
      kind.resource,
      namespaces.map((namespace) => ({ namespace })),
    ).then((reason) => {
      if (live) bulkDenied = reason;
    });
    return () => (live = false);
  });

  // Keyboard focus: one row, by key, so it stays on the same object when
  // watch batches reorder the table. Separate from the checkboxes.
  let focusedKey = $state<string | null>(null);
  let lastFocusedIndex = -1;
  const focusedIndex = $derived(focusedKey === null ? -1 : visibleKeys.indexOf(focusedKey));
  let gridEl = $state<HTMLDivElement | null>(null);
  let list: VirtualList | undefined = $state();

  // The focused row went away (deleted, filtered out): focus its neighbour.
  $effect(() => {
    if (focusedIndex >= 0) lastFocusedIndex = focusedIndex;
    else if (focusedKey !== null) {
      focusedKey = visibleKeys.length > 0 ? visibleKeys[Math.min(lastFocusedIndex, visibleKeys.length - 1)] : null;
    }
  });

  function focusRow(index: number) {
    const key = visibleKeys[index];
    if (key === undefined) return;
    focusedKey = key;
    list?.scrollToIndex(index);
    gridEl?.focus({ preventScroll: true });
  }

  function move(to: RowMove) {
    const last = visible.length - 1;
    if (last < 0) return;
    // Start from the row in the detail panel when nothing has focus yet.
    const from = focusedIndex >= 0 ? focusedIndex : selectedKey ? visibleKeys.indexOf(selectedKey) : -1;
    const next = {
      next: from < 0 ? 0 : Math.min(from + 1, last),
      prev: from < 0 ? 0 : Math.max(from - 1, 0),
      first: 0,
      last,
    }[to];
    focusRow(next);
  }

  const focusedEntry = () => (focusedIndex >= 0 ? visible[focusedIndex] : undefined);

  function menuForFocused() {
    const entry = focusedEntry();
    if (!entry) return;
    list?.scrollToIndex(focusedIndex);
    // Under the row's ⋮ button when it is in view, as a click on it would.
    const more = document.getElementById(rowId(focusedIndex))?.querySelector('[data-testid="row-menu"]');
    const m = more?.getBoundingClientRect();
    if (m && m.width > 0 && m.right <= window.innerWidth) {
      openMenuAt(m.right, m.bottom, entry.row);
      return;
    }
    const rect = document.getElementById(rowId(focusedIndex))?.getBoundingClientRect();
    openMenuAt(rect ? rect.left + 40 : 100, rect ? rect.bottom : 100, entry.row);
  }

  // The keyboard Delete (#349): asks the access check first, like the menu
  // and the bulk bar, and says why instead of opening a dialog the API
  // server would refuse (a read-only context's reason comes first).
  let deleteCheck = 0;
  async function deleteRows() {
    const del = deleteAction;
    if (!del) return;
    const entry = focusedEntry();
    const targets =
      selected.size > 0
        ? targetsOf(selected)
        : entry
          ? [{ namespace: entry.row.namespace, name: entry.row.name }]
          : [];
    if (targets.length === 0) return;
    const token = ++deleteCheck;
    const asked = visibleCluster();
    const reason = await deleteDenied(kind.resource, targets);
    // Pressed again meanwhile, or the window switched cluster: these rows
    // are not the ones it shows any more.
    if (token !== deleteCheck || visibleCluster() !== asked) return;
    if (reason) setNotice(false, reason, { level: "warning" });
    else requestAction(kind, targets, del);
  }

  onMount(() =>
    registerTable({
      get kind() {
        return kind;
      },
      move,
      openFocused: () => {
        const entry = focusedEntry();
        if (entry) onselect?.(entry.row);
      },
      toggleFocused: () => {
        if (focusedKey !== null && focusedIndex >= 0) toggleRow(focusedKey, false);
      },
      menuForFocused,
      deleteRows,
      rows: () => store.entries.map((e) => e.row),
      actionTargets: () => {
        if (selected.size > 0) return { targets: targetsOf(selected), row: null };
        const entry = focusedEntry() ?? visible.find((e) => e.key === selectedKey);
        return entry
          ? { targets: [{ namespace: entry.row.namespace, name: entry.row.name }], row: entry.row }
          : { targets: [], row: null };
      },
      focus: () => gridEl?.focus({ preventScroll: true }),
    }),
  );

  // The toolbar's Export CSV (#221): what is on screen, as it is shown.
  onMount(() =>
    registerTableExport({
      get kind() {
        return kind;
      },
      rows: () => visible.length,
      csv: () =>
        tableCsv(
          columns,
          visible.map((e) => e.row),
          { metrics, now },
        ),
    }),
  );

  /** DOM id of row `i`, for `aria-activedescendant`. */
  const rowId = (i: number) => `resource-row-${i}`;

  function toggleSort(key: string) {
    if (sort?.key !== key) sort = { key, dir: "asc" };
    else if (sort.dir === "asc") sort = { key, dir: "desc" };
    else sort = null;
    updateSettings({ kinds: { [kind.id]: withSort(kindSettings(kind.id), sort) } });
  }
</script>

<div class="table" data-testid="resource-table">
  {#if selected.size > 0}
    <div class="bulk" role="toolbar" aria-label="Selection">
      <span>{selected.size} selected</span>
      {#if deleteAction}
        <button
          type="button"
          class="btn danger"
          class:denied={!!bulkDenied}
          aria-disabled={bulkDenied ? "true" : undefined}
          aria-describedby={bulkDenied ? "bulk-deny" : undefined}
          title={bulkDenied || undefined}
          onclick={deleteSelected}>Delete {selected.size}…</button
        >
        {#if bulkDenied}<span class="bulk-reason" id="bulk-deny" data-testid="bulk-reason">{bulkDenied}</span>{/if}
      {/if}
      <button type="button" class="btn" onclick={() => (selected = new Set())}>Clear</button>
    </div>
  {/if}
  <!-- ARIA grid: the grid keeps DOM focus and points at the focused row. -->
  <div
    class="grid"
    role="grid"
    tabindex="0"
    aria-label={kind.label}
    aria-rowcount={visible.length + 1}
    aria-colcount={columns.length + 2}
    aria-multiselectable="true"
    aria-activedescendant={focusedIndex >= 0 ? rowId(focusedIndex) : undefined}
    bind:this={gridEl}
  >
    <div
      class="head"
      role="row"
      aria-rowindex={1}
      style:grid-template-columns={template}
      style:padding-right="{gutter}px"
      style:min-width="{minWidth + gutter}px"
      style:transform={scrollLeft ? `translateX(${-scrollLeft}px)` : undefined}
    >
      <div class="th check" role="columnheader">
        <input
          type="checkbox"
          aria-label="Select all visible rows"
          checked={allSelected}
          indeterminate={someSelected}
          onchange={toggleAll}
        />
      </div>
      {#each columns as col (col.key)}
        <button
          type="button"
          class="th"
          role="columnheader"
          aria-sort={sort?.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
          title={col.label}
          onclick={() => toggleSort(col.key)}
        >
          <span class="label">{col.label}</span>
          {#if sort?.key === col.key}<span class="arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>{/if}
        </button>
      {/each}
      <div class="th more" role="columnheader" aria-label="Actions"></div>
    </div>

    <VirtualList
      bind:this={list}
      count={visible.length}
      rowHeight={ROW_HEIGHT}
      {getKey}
      bind:scrollEl
      scrollX
      {minWidth}
      onscroll={(e) => (scrollLeft = (e.currentTarget as HTMLElement).scrollLeft)}
    >
      {#snippet row(i)}
        {@const entry = visible[i]}
        {#if entry}
          <!-- Rows take no focus: the grid does, and points at the focused row
               (aria-activedescendant); keys are handled in stores/keyboard.svelte.ts. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            class="tr"
            id={rowId(i)}
            data-testid="resource-row"
            class:clickable={!!onselect}
            class:selected={entry.key === selectedKey}
            class:checked={selected.has(entry.key)}
            class:focused={i === focusedIndex}
            class:problem={!!entry.row.problem}
            data-problem={entry.row.problem || undefined}
            role="row"
            aria-rowindex={i + 2}
            aria-selected={selected.has(entry.key)}
            style:grid-template-columns={template}
            style:min-width="{minWidth}px"
            onclick={() => {
              focusedKey = entry.key;
              onselect?.(entry.row);
              // The keyboard follows the click (#207), even when focus was in
              // the filter, the detail panel or the dock.
              gridEl?.focus({ preventScroll: true });
            }}
            oncontextmenu={(e) => openMenu(e, entry.row)}
          >
            <div class="td check" role="gridcell" title={entry.row.problem || undefined}>
              <input
                type="checkbox"
                aria-label="Select {entry.row.name}"
                checked={selected.has(entry.key)}
                onclick={(e) => {
                  e.stopPropagation();
                  toggleRow(entry.key, e.shiftKey);
                }}
                onchange={() => {}}
              />
            </div>
            {#each columns as col (col.key)}
              {@const text = col.text(entry.row, { metrics, now })}
              {@const spark = col.spark?.(entry.row, { metrics, now })}
              {@const link = cellLink(kinds.all, kind, col, text, entry.row.namespace)}
              <div
                class="td {col.cls?.(entry.row) ?? ''}"
                role="gridcell"
                title={col.title?.(entry.row, settings.current.time_zone) ||
                  (spark && spark.length > 1 ? `${text}, trend since ${clockTime(metrics.since)}` : text)}
              >
                {#if link && col.link === "owner"}
                  <!-- The owner's name is the link (#378). Out of the tab order
                       like the rows: the grid has the focus. -->
                  <button
                    type="button"
                    class="cell-link"
                    tabindex="-1"
                    data-testid="owner-link"
                    title={link.title}
                    onmousedown={noMiddle}
                    onauxclick={swallow}
                    onclick={(e) => follow(e, link)}>{text}</button
                  >
                {:else if link}
                  <!-- A namespace or node: the text stays the row's (a click on
                       it opens the row, as everywhere in the row); a small link
                       after it, shown on hover and focus, leads to what it
                       names (#382). -->
                  <span class="linked"
                    ><span class="linked-text">{text}</span><button
                      type="button"
                      class="link-icon"
                      tabindex="-1"
                      data-testid={link.to === "namespace" ? "namespace-link" : "node-link"}
                      aria-label={link.title}
                      title={link.title}
                      onmousedown={noMiddle}
                      onauxclick={swallow}
                      onclick={(e) => follow(e, link)}
                    >
                      {#if link.to === "namespace"}
                        <!-- A funnel: show only this namespace. -->
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path
                            d="M2.5 3h11l-4.2 5.2v4.3l-2.6 1.3V8.2z"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linejoin="round"
                          />
                        </svg>
                      {:else}
                        <!-- An arrow: open the node. -->
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path
                            d="M5 11l6-6M6 5h5v5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      {/if}
                    </button></span
                  >
                {:else if col.draw === "containers"}
                  <ContainerSquares cell={text} />
                {:else if col.draw === "rollout"}
                  <RolloutStatus word={text} />
                {:else}
                  {text}{#if spark}<Sparkline values={spark} />{/if}
                {/if}
              </div>
            {/each}
            <div class="td more" role="gridcell">
              <button
                type="button"
                class="more-btn"
                tabindex="-1"
                data-testid="row-menu"
                aria-label="Actions for {entry.row.name}"
                title="Actions (Shift+F10)"
                aria-haspopup="menu"
                onclick={(e) => openMenuFromButton(e, entry.row)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <circle cx="8" cy="3.5" r="1.4" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>
        {/if}
      {/snippet}
    </VirtualList>
  </div>

  {#if menu}
    <ContextMenu {...menu} onclose={() => (menu = null)} />
  {/if}

  {#if visible.length === 0}
    <div class="empty">
      <CalmWater mark="buoy">
        <p class="way-out">
          <span>No items found.</span>
          {#if app.search}
            <button type="button" class="btn" data-testid="clear-filter" onclick={() => (app.search = "")}
              >Clear the filter "{app.search}"</button
            >
          {/if}
        </p>
      </CalmWater>
    </div>
  {/if}
</div>

<style>
  .table {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 16px 16px;
    position: relative;
  }
  .grid {
    flex: 1;
    min-height: 0;
    min-width: 0;
    /* Columns wider than the table are cut off here, like the rows in the
       scroller. Without the clip the header labels overflow into the detail
       panel and, being text, paint over its background (#57). */
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .grid:focus-visible .tr.focused {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .tr.focused {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .head {
    display: grid;
    height: 28px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .th {
    /* A label wider than its column is cut with an ellipsis, like the cells
       below it, instead of running into the next header (#140). */
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    padding: 0 10px;
    background: transparent;
    border: none;
    /* Sentence case at the rows' size (#384); the weight and colour, not
       capitals, set it apart from the cells. */
    color: var(--text-muted);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .th:hover {
    color: var(--text);
  }
  .arrow {
    flex-shrink: 0;
    font-size: 9px;
    margin-left: 4px;
  }
  .tr {
    display: grid;
    align-items: center;
    height: 100%;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    /* The row's tint, as a variable so the sticky ⋮ cell can paint it too. */
    background: var(--row-bg, transparent);
  }
  .tr:hover {
    --row-bg: var(--bg-hover);
  }
  /* A status cell leads with a dot of its colour (the phase-* classes). */
  .td[class*="phase-"]::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 7px;
    border-radius: 50%;
    background: currentColor;
    vertical-align: 1px;
  }
  .tr.clickable {
    cursor: pointer;
  }
  /* The row open in the detail panel: lit teal, as the sidebar's view. */
  .tr.selected {
    --row-bg: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .tr.checked {
    --row-bg: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  /* Needs attention (the backend's `problem`): a red edge and a faint tint. */
  .tr.problem {
    box-shadow: inset 2px 0 0 var(--red);
  }
  .tr.problem:not(.selected, .checked) {
    --row-bg: color-mix(in srgb, var(--red) 7%, transparent);
  }
  .tr.problem:not(.selected, .checked):hover {
    --row-bg: color-mix(in srgb, var(--red) 12%, transparent);
  }
  .tr.problem.focused {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .check {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    font-size: 13px;
  }
  .btn.danger {
    border-color: var(--red);
    color: var(--error-text);
  }
  .btn.denied {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .bulk-reason {
    color: var(--text-muted);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .td {
    padding: 0 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A link only on hover or focus, so the table doesn't turn blue (#382). */
  .cell-link {
    all: unset;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .cell-link:hover,
  .cell-link:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }
  /* The text keeps the whole cell; the link sits over the cell's right end,
     in the row's tint, and only while the row is hovered or focused, so the
     table stays calm and the text is not cut short for it. */
  .td:has(.linked) {
    position: relative;
  }
  .link-icon {
    all: unset;
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--text-muted);
    background:
      linear-gradient(var(--row-bg, transparent), var(--row-bg, transparent)),
      var(--bg);
    cursor: pointer;
    opacity: 0;
  }
  .tr:hover .link-icon,
  .tr.focused .link-icon,
  .link-icon:focus-visible {
    opacity: 1;
  }
  .link-icon:hover,
  .link-icon:focus-visible {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .link-icon:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* The ⋮ stays at the right edge when the columns scroll sideways, over
     the cells, in the row's own tint. */
  .td.more {
    position: sticky;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    padding: 0;
    background:
      linear-gradient(var(--row-bg, transparent), var(--row-bg, transparent)),
      var(--bg);
  }
  .th.more {
    cursor: default;
  }
  .more-btn {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .more-btn:hover,
  .more-btn:focus-visible {
    color: var(--text);
    background: var(--bg-hover);
  }
  .more-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .empty {
    position: absolute;
    top: 56px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
  }
  .empty p {
    margin: 0;
  }
  .empty .way-out {
    display: flex;
    align-items: center;
    gap: 10px;
  }
</style>
