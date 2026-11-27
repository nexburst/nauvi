<script lang="ts">
  import EmptyState from "./EmptyState.svelte";
  import { emptyState, type EmptyAction } from "../emptyState";
  import { openCreate } from "../stores/create.svelte";
  import OutOfReach from "./OutOfReach.svelte";
  import { troubleTitle } from "../health";
  import { chart } from "../stores/chart.svelte";
  import { visibleRows } from "../stores/visibleRows.svelte";
  import { app, kinds, openObject, setNamespaces, switchNamespace } from "../stores/app.svelte";
  import { cellLink, type CellLink } from "../cellLinks";
  import { rowHeightPx } from "../preferences";
  import { onDestroy, onMount, untrack } from "svelte";
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
  import { detail, sameTarget } from "../stores/detail.svelte";
  import { agentPrompt } from "../agent";
  import { deleteDenied, deniedActions, namespacesOf } from "../access";
  import { visibleCluster } from "../cluster";
  import { dockMenuFor } from "../dock";
  import { openDockTab } from "../stores/dock.svelte";
  import { copyLink, prefetchLink } from "../stores/links.svelte";
  import { registerTable } from "../stores/keyboard.svelte";
  import type { RowMove } from "../stores/keyboard.svelte";
  import type { ResourceKind } from "../bindings";
  import { columnsFor, shownColumns, statusIcon } from "../columns";
  import type { Metrics, Row } from "../columns";
  import { MAX_DRAG, MIN_DRAG, TableFit } from "../stores/tableFit.svelte";
  import Icon from "../icons/Icon.svelte";
  import RowQuickActions, { type Quick } from "./RowQuickActions.svelte";
  import type { KeyedStore } from "../stores/keyed.svelte";
  import type { Sort } from "../view";
  import { activeFilter, ListFilter, shownHay } from "../stores/tableFilter.svelte";
  import { cutHit } from "../tableFilter";
  import { ALWAYS_SHOWN, sortOf, toggleColumn, withSort } from "../settings";
  import { orderColumns } from "../columnOrder";
  import { customKey, customSourceText } from "../customColumns";
  import { openColumnChooser } from "../stores/tableColumns.svelte";
  import { kindSettings, settings, updateKind, updateSettings } from "../stores/settings.svelte";
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
    /** A first batch has arrived: an empty table is empty, not loading. */
    synced?: boolean;
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
    synced = true,
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
  // In the order the user put them in (#547).
  const order = $derived(kindSettings(kind.id).order ?? []);
  const columns = $derived(shownColumns(orderColumns(columnsFor(kind), order), hidden, metrics, shownExtra));
  // The checkbox, the columns, then the row's ⋮ menu (#382).
  const CHECK_PX = 32;
  const MORE_PX = 28;

  // Fitted columns (#482): each as wide as its widest value and header,
  // the spare width to Name, the long text columns giving way (Name last)
  // when the table is short of room; what the user dragged a column to is
  // remembered per kind. See tableFit.svelte.ts and columnFit.ts.
  const userWidths = $derived(kindSettings(kind.id).widths ?? {});
  const fit = new TableFit({
    columns: () => columns,
    rows: () => visible,
    ctx: () => ({ metrics, now: untrack(() => now) }),
    sortKey: () => sort?.key,
    userWidths: () => userWidths,
  });
  const template = $derived([CHECK_PX, ...fit.widths, MORE_PX].map((w) => `${w}px`).join(" "));
  // Columns that don't fit (extra ones turned on, the detail panel open)
  // scroll sideways, the header with the rows, instead of being cut off.
  const minWidth = $derived(CHECK_PX + fit.total + MORE_PX);
  /** Where each column ends, px from the table's left edge: its resize handle. */
  const edges = $derived(fit.widths.reduce<number[]>((acc, w) => [...acc, (acc.at(-1) ?? CHECK_PX) + w], []));
  $effect(() => {
    // The shown rows, the columns or the metrics changed.
    void columns;
    void visible;
    void metrics;
    untrack(() => fit.changed());
  });
  onDestroy(() => fit.stop());
  onMount(() => {
    const grid = gridEl;
    if (!grid) return;
    fit.attach(grid);
    // Once the fonts are in, measure again in them.
    let live = true;
    void document.fonts?.ready.then(() => live && fit.attach(grid));
    const ro = new ResizeObserver(() => (fit.avail = Math.max(0, grid.clientWidth - CHECK_PX - MORE_PX - gutter)));
    ro.observe(grid);
    return () => {
      live = false;
      ro.disconnect();
    };
  });
  $effect(() => {
    // The scrollbar's gutter is taken from the columns' width.
    void gutter;
    if (gridEl) fit.avail = Math.max(0, gridEl.clientWidth - CHECK_PX - MORE_PX - gutter);
  });

  // Resizing (#482): drag a header's right edge; double-click it to fit
  // the column to its values, again to let it fit by itself.
  function saveWidth(key: string, px: number | null) {
    const next = { ...userWidths };
    if (px === null) delete next[key];
    else next[key] = Math.round(Math.min(MAX_DRAG, Math.max(MIN_DRAG, px)));
    updateKind(kind.id, { widths: next });
  }
  function startResize(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const key = columns[i].key;
    const x0 = e.clientX;
    const w0 = fit.widths[i];
    const move = (ev: PointerEvent) => {
      fit.dragging = { key, px: Math.round(Math.min(MAX_DRAG, Math.max(MIN_DRAG, w0 + ev.clientX - x0))) };
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (fit.dragging) saveWidth(key, fit.dragging.px);
      fit.dragging = null;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
  function fitColumn(i: number) {
    const col = columns[i];
    if (userWidths[col.key] !== undefined) saveWidth(col.key, null);
    else saveWidth(col.key, fit.natural(col.key) ?? col.fit.min);
  }
  let scrollLeft = $state(0);
  // svelte-ignore state_referenced_locally
  let sort = $state.raw<Sort | null>(sortOf(kindSettings(kind.id)));

  // Re-evaluated when the rows, the filter, the sort, or (only when sorting by
  // a metric / age column) the metrics or clock change.
  // The toolbar filter (#219): text, match case or a regex in the worker.
  // It matches what the rows show (#512): name, namespace and the cells of
  // the shown columns; a regex runs again when the shown columns change,
  // not on each metrics refresh.
  const hay = shownHay(
    () => kind.columns,
    () => columns,
  );
  const filter = new ListFilter(() => (void hay.current, store.entries), {
    key: (e) => e.key,
    lower: (e) => hay.current.lower(e.row),
    text: (e) => hay.current.raw(e.row),
  });
  // The clock is read untracked there: an age tick redraws the Age cells only.
  const rows = visibleRows(
    () => ({ entries: store.entries, match: filter.match, sort, columns, metrics, status }),
    () => now,
  );
  const visible = $derived(rows.value);
  /** The header status while the cluster does not answer (#462). */
  const trouble = $derived(troubleTitle(app.status));
  const getKey = $derived((i: number) => visible[i]?.key ?? i);

  // Why the table is empty, and what to do (#485).
  const empty = $derived(
    emptyState({
      label: kind.label,
      plural: kind.resource.plural,
      group: kind.resource.group,
      namespaced: kind.resource.namespaced,
      verbs: kind.verbs,
      namespaces: app.selectedNamespaces,
      search: app.search,
      status,
      total: store.entries.length,
      synced,
      denied: kinds.denied.has(kind.id) || app.status.text.startsWith("Not allowed"),
    }),
  );
  function emptyAction(id: EmptyAction) {
    if (id === "clearFilter") app.search = "";
    else if (id === "clearStatus") app.statusFilter = "";
    else if (id === "allNamespaces") setNamespaces([]);
    else openCreate();
  }

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

  /** The keys of registry actions that have one (keys.ts). */
  const ACTION_KEYS: Partial<Record<string, string>> = { restart: "⇧R", delete: "Del" };

  // Right-click menu, built from the same registry as the detail panels.
  let menu = $state.raw<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);

  /** A header's tooltip: its name, and where a custom column reads from. */
  function headerTitle(col: (typeof columns)[number]): string {
    const c = kindSettings(kind.id).custom?.find((c) => customKey(c.id) === col.key);
    return c ? `${col.label} (${customSourceText(c)})` : col.label;
  }

  // A header's right-click menu (#547): the Columns chooser's choices,
  // found without knowing its button.
  function openHeaderMenu(e: MouseEvent, col: (typeof columns)[number]) {
    e.preventDefault();
    const fixed = ALWAYS_SHOWN.includes(col.key);
    menu = {
      x: e.clientX,
      y: e.clientY,
      title: col.label,
      items: [
        {
          label: "Hide this column",
          reason: fixed ? `${col.label} is always shown` : undefined,
          run: () => updateKind(kind.id, toggleColumn(kindSettings(kind.id), col)),
        },
        { label: "Columns…", run: () => openColumnChooser(kind.id) },
      ],
    };
  }

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
      // Logs and Shell open dock tabs, then the YAML editor (#494); the
      // rest come from the action registry. Each with its key, so the menu
      // teaches the keys.
      items = [
        ...dockMenuFor(kind.resource, row.namespace, row.name).map((d) => ({
          id: d.label === "Shell" ? "shell" : "logs",
          label: d.label,
          key: d.label === "Shell" ? "S" : "L",
          run: () => openDockTab(d.spec),
        })),
        { id: "edit", label: "Edit YAML", key: "E", run: () => verbOn(row, "edit") },
        // A nauvi:// link to the object (#299).
        { label: "Copy link", run: () => void copyLink(kind.resource, row.namespace, row.name) },
        // For the user's own agent (docs/ux-standard.md, section 10).
        { label: "Copy as prompt", key: "A", run: () => void copyPrompt(row) },
        ...kind.actions.map((a) => ({
          id: a.id,
          label: a.label,
          key: ACTION_KEYS[a.id],
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

  // The selected row in view (#496): when a link (Overview, a related
  // object) selects it, once its row has arrived, and when the table gets
  // shorter (the dock opens) while it was in view. Once per selection, so
  // the user can scroll away from it.
  let shownKey: string | null = null;
  $effect(() => {
    const key = selectedKey;
    if (!key) {
      shownKey = null;
      return;
    }
    const index = visibleKeys.indexOf(key);
    if (index < 0 || shownKey === key) return;
    shownKey = key;
    untrack(() => list?.scrollToIndex(index, rowInView(index) ? "auto" : "center"));
  });
  /** Row `index` is (wholly) inside the scroller. */
  function rowInView(index: number, height = scrollEl?.clientHeight ?? 0) {
    if (!scrollEl) return false;
    const top = index * ROW_HEIGHT - scrollEl.scrollTop;
    return top >= 0 && top + ROW_HEIGHT <= height;
  }
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const before = height;
      height = el.clientHeight;
      if (height >= before || !selectedKey) return;
      const index = visibleKeys.indexOf(selectedKey);
      if (index >= 0 && rowInView(index, before) && !rowInView(index)) list?.scrollToIndex(index);
    });
    ro.observe(el);
    return () => ro.disconnect();
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
  /**
   * A verb on the focused row (or the one in the panel), as k9s has them:
   * logs, a shell, or its YAML editor. What RBAC refuses says why.
   */
  let verbCheck = 0;
  /** The keys that do something for this kind's rows, for the hint strip. */
  const rowKeys = $derived.by(() => {
    const dock = dockMenuFor(kind.resource, "", "x").map((d) => d.label);
    const keys: [string, string][] = [["↵", "open"]];
    if (dock.includes("Logs")) keys.push(["L", "logs"]);
    if (dock.includes("Shell")) keys.push(["S", "shell"]);
    keys.push(["E", "yaml"]);
    if (kind.actions.some((a) => a.id === "restart")) keys.push(["⇧R", "restart"]);
    keys.push(["A", "prompt"], ["Space", "select"], ["/", "filter"], ["?", "all keys"]);
    return keys;
  });
  /** A prompt about the row for the user's own agent, on the clipboard. */
  async function copyPrompt(row: Row) {
    const at = columns.findIndex((c) => c.key === "restarts");
    const restarts = at >= 0 ? Number(columns[at].text(row, { metrics, now })) : 0;
    const text = agentPrompt({
      cluster: visibleCluster(),
      kind: kind.resource.kind,
      namespace: row.namespace,
      name: row.name,
      problem: row.problem ? `${row.problem}${restarts > 0 ? `, ${restarts} restarts` : ""}` : "",
    });
    try {
      await navigator.clipboard.writeText(text);
      setNotice(true, `Copied a prompt about ${row.name}. Paste it into your agent.`, { level: "info" });
    } catch {
      setNotice(false, "Could not copy to the clipboard.");
    }
  }

  type Verb = "logs" | "shell" | "edit" | "restart" | "prompt";
  function rowVerb(verb: Verb) {
    const row = (focusedEntry() ?? visible.find((e) => e.key === selectedKey))?.row;
    if (row) void verbOn(row, verb);
  }

  /** The row's quick actions, shown on hover (#482): its dock tabs and its YAML. */
  const quick = $derived.by(() => {
    const dock = dockMenuFor(kind.resource, "", "x").map((d) => d.label);
    const out: Quick[] = [];
    if (dock.includes("Logs")) out.push({ verb: "logs", label: "Logs", key: "L", icon: "logs" });
    if (dock.includes("Shell")) out.push({ verb: "shell", label: "Shell", key: "S", icon: "terminal" });
    out.push({ verb: "edit", label: "Edit YAML", key: "E", icon: "edit" });
    return out;
  });
  /** The row under the pointer, for its quick actions. */
  let hoverKey = $state<string | null>(null);
  /** The grid has the DOM focus: the focused row shows its quick actions
   *  too (#507), not only the one under the pointer. */
  let gridFocused = $state(false);

  function quickVerb(e: MouseEvent, row: Row, verb: Verb) {
    e.stopPropagation();
    if (!stillOwnCluster()) return;
    focusedKey = row.key;
    gridEl?.focus({ preventScroll: true });
    void verbOn(row, verb);
  }

  async function verbOn(row: Row, verb: Verb) {
    if (verb === "prompt") return copyPrompt(row);
    if (verb === "edit") {
      const t = detail.target;
      if (t && sameTarget(t, { resource: kind.resource, namespace: row.namespace, name: row.name })) {
        // Already open: its own Edit shows the YAML, without opening it again
        // (that would rebuild the editor under the user).
        document.querySelector<HTMLElement>('[data-testid="detail-panel"] button[data-action="edit"]')?.click();
        return;
      }
      detail.yaml = true;
      onselect?.(row);
      return;
    }
    if (verb === "restart") {
      // The action's own dialog confirms it.
      const action = kind.actions.find((a) => a.id === "restart");
      if (!action) return setNotice(true, `${kind.label} cannot be restarted.`, { level: "info" });
      const token = ++verbCheck;
      const asked = visibleCluster();
      const reason = (await deniedActions(kind.resource, row.namespace, ["restart"])).get("restart");
      if (token !== verbCheck || visibleCluster() !== asked) return;
      if (reason) setNotice(false, reason, { level: "warning" });
      else requestAction(kind, [{ namespace: row.namespace, name: row.name }], action, 1, true);
      return;
    }
    const item = dockMenuFor(kind.resource, row.namespace, row.name).find((d) => d.label === (verb === "shell" ? "Shell" : "Logs"));
    if (!item) {
      setNotice(true, `${kind.label} have no ${verb === "shell" ? "shell" : "logs"}.`, { level: "info" });
      return;
    }
    const token = ++verbCheck;
    const asked = visibleCluster();
    const reason = (await deniedActions(kind.resource, row.namespace, [verb])).get(verb);
    if (token !== verbCheck || visibleCluster() !== asked) return;
    if (reason) setNotice(false, reason, { level: "warning" });
    else openDockTab(item.spec);
  }

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
        if (entry) {
          detail.yaml = false;
          onselect?.(entry.row);
        }
      },
      toggleFocused: () => {
        if (focusedKey !== null && focusedIndex >= 0) toggleRow(focusedKey, false);
      },
      menuForFocused,
      deleteRows,
      rowVerb,
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
    onfocusin={() => (gridFocused = true)}
    onfocusout={(e) => (gridFocused = gridEl?.contains(e.relatedTarget as Node | null) ?? false)}
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
          title={headerTitle(col)}
          onclick={() => toggleSort(col.key)}
          oncontextmenu={(e) => openHeaderMenu(e, col)}
        >
          <span class="label">{col.label}</span>
          {#if sort?.key === col.key}<span class="arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>{/if}
        </button>
      {/each}
      <div class="th more" role="columnheader" aria-label="Actions"></div>
      <!-- The columns' right edges: drag to resize, double-click to fit
           (#482). A pointer aid only, so not in the accessibility tree. -->
      {#each columns as col, i (col.key)}
        <div
          class="resize"
          class:active={fit.dragging?.key === col.key}
          aria-hidden="true"
          data-testid="col-resize"
          data-col={col.key}
          title="Drag to resize, double-click to fit"
          style:left="{edges[i] - 4}px"
          onpointerdown={(e) => startResize(e, i)}
          ondblclick={() => fitColumn(i)}
        ></div>
      {/each}
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
              // E's flag is still set if its panel never opened (discard refused).
              detail.yaml = false;
              onselect?.(entry.row);
              // The keyboard follows the click (#207), even when focus was in
              // the filter, the detail panel or the dock.
              gridEl?.focus({ preventScroll: true });
            }}
            oncontextmenu={(e) => openMenu(e, entry.row)}
            onpointerenter={() => (hoverKey = entry.key)}
            onpointerleave={() => {
              if (hoverKey === entry.key) hoverKey = null;
            }}
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
            {#each columns as col, c (col.key)}
              {@const text = col.text(entry.row, { metrics, now })}
              {@const spark = col.spark?.(entry.row, { metrics, now })}
              {@const link = cellLink(kinds.all, kind, col, text, entry.row.namespace)}
              {@const cls = col.cls?.(entry.row) ?? ""}
              {@const shown = col.draw ? { text, cut: false } : fit.shown(c, text)}
              {@const own = col.title?.(entry.row, settings.current.time_zone, { metrics, now })}
              {@const hit = shown.cut && cutHit(activeFilter(), text, shown.text)}
              <!-- The whole value in the tooltip when the cell cuts it (#482). -->
              <div
                class="td {cls}"
                class:cut={shown.cut}
                class:hit
                role="gridcell"
                aria-label={shown.text !== text ? text : undefined}
                title={shown.cut
                  ? hit
                    ? `${text} (matches the filter)`
                    : text
                  : spark && spark.length > 1
                    ? `${own || text}, trend since ${clockTime(metrics.since)}`
                    : own || undefined}
              >
                <!-- A state as an icon too, not by colour alone (#482). No
                     space between it and the text: STATUS_ICON_PX is all it takes. -->
                {#if col.cls}{@const icon = statusIcon(cls)}<span class="st-icon"
                    >{#if icon}<Icon name={icon} size={14} />{/if}</span
                  >{/if}{#if link && col.link === "owner"}
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
                    onclick={(e) => follow(e, link)}>{shown.text}</button
                  >
                {:else if link}
                  <!-- A namespace or node: the text stays the row's (a click on
                       it opens the row, as everywhere in the row); a small link
                       after it, shown on hover and focus, leads to what it
                       names (#382). -->
                  <span class="linked"
                    ><span class="linked-text">{shown.text}</span><button
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
                  {shown.text}{#if spark}<Sparkline values={spark} />{/if}
                {/if}
              </div>
            {/each}
            <div class="td more" role="gridcell">
              {#if entry.key === hoverKey || (gridFocused && i === focusedIndex)}
                <!-- The row's own actions on hover (#482) and on the
                     keyboard's row while the grid has the focus (#507), so
                     the ⋮ menu is not the only way to them. Only on those
                     rows: they cover the end of the last cell. -->
                <RowQuickActions name={entry.row.name} items={quick} run={(e, verb) => quickVerb(e, entry.row, verb)} />
              {/if}
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

  {#if focusedIndex >= 0 && visible.length > 0}
    <!-- What the keyboard can do with the focused row. Drawn, not text, so
         it is never read as part of the table. -->
    <div class="keys" aria-hidden="true" data-testid="row-keys">
      {#each rowKeys as [key, what] (key)}
        <span class="key"><kbd>{key}</kbd>{what}</span>
      {/each}
    </div>
  {/if}

  {#if visible.length === 0 && trouble}
    <!-- Not "No items found" while the cluster does not answer (#462). -->
    <div class="empty">
      <OutOfReach title={trouble} />
    </div>
  {:else if visible.length === 0}
    {@const e = empty}
    <div class="empty">
      {#if e.reason === "loading"}
        <p class="muted loading" data-testid="table-loading">{e.title}</p>
      {:else}
      <EmptyState title={e.title} detail={e.detail} reason={e.reason}>
        {#each e.actions as a, i (a.id)}
          <button
            type="button"
            class="btn"
            class:primary={i === 0}
            data-testid={a.id === "clearFilter" ? "clear-filter" : `empty-${a.id}`}
            onclick={() => emptyAction(a.id)}>{a.label}</button
          >
        {/each}
      </EmptyState>
      {/if}
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
    position: relative;
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
    padding: 0 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font: inherit;
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
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
  /* A status cell leads with an icon in its colour (the phase-* classes);
     14 px and a 6 px gap: STATUS_ICON_PX. */
  .st-icon {
    display: inline-flex;
    width: 14px;
    height: 14px;
    margin-right: 6px;
    vertical-align: -2.5px;
    --icon-stroke: 2;
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
    padding: 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A cut cell that matches the filter only in the part it hides (#512):
     the row shows why it is listed; the tooltip has the whole value. */
  .td.hit {
    background: var(--accent-soft);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  /* One quiet line under the rows: the keys for the focused row. */
  .keys {
    display: flex;
    gap: 14px;
    flex-shrink: 0;
    padding: 5px 4px 0;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .keys kbd {
    font-family: var(--font-num);
    font-size: 10px;
    padding: 0 4px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    color: var(--text);
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
  /* A column's right edge in the header: a thin line on hover, the cursor
     says it resizes. */
  .resize {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    cursor: col-resize;
    touch-action: none;
    z-index: 1;
  }
  .resize::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 6px;
    bottom: 6px;
    width: 1px;
    background: var(--border);
  }
  .resize:hover::after,
  .resize.active::after {
    top: 0;
    bottom: 0;
    width: 2px;
    left: 3.5px;
    background: var(--accent);
  }
  /* The row's quick actions sit over the end of the last cells, in the
     row's tint, only while it is hovered. */
  .td.more {
    overflow: visible;
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
  /* Quick loads show nothing; a slow one says what it waits for. */
  .empty .loading {
    font-size: var(--text-base);
    animation: appear 200ms ease 400ms both;
  }
  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>
