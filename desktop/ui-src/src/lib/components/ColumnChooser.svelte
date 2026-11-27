<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { CustomColumn, CustomSource, ResourceKind } from "../bindings";
  import { columnsFor } from "../columns";
  import type { Column } from "../columns";
  import { moveKey, moveTo, orderColumns } from "../columnOrder";
  import {
    customColumnError,
    customKey,
    customSourceText,
    MAX_CUSTOM,
    newCustomId,
    SOURCE_HINTS,
    SOURCE_LABELS,
  } from "../customColumns";
  import { ALWAYS_SHOWN, columnOn, columnsChanged, DEFAULT_COLUMNS, toggleColumn } from "../settings";
  import { keyboard } from "../stores/keyboard.svelte";
  import { kindSettings, updateKind } from "../stores/settings.svelte";
  import { currentContextName } from "../stores/app.svelte";
  import { chooserRequest, tableKind } from "../stores/tableColumns.svelte";

  /** Show, hide and order the table's columns, and add custom ones (#547);
   *  remembered per kind. The table's columns are listed in their order
   *  (drag, or Alt+↑/↓, to move one); the off-by-default ones (#378) that
   *  are off wait under "More columns". */
  let { kind }: { kind: ResourceKind } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let search = $state("");
  /** Said to screen readers after a move. */
  let announce = $state("");

  const shownKind = $derived(tableKind(kind));
  const settings = $derived(kindSettings(kind.id));
  // Not the ones that do not exist right now (Vulns while image security is off, #535).
  const columns = $derived(columnsFor(shownKind).filter((c) => c.available?.() ?? true));
  const ordered = $derived(orderColumns(columns, settings.order ?? []));
  /** The table's columns, in order: all but the extra ones that are off. */
  const listed = $derived(ordered.filter((c) => !c.defaultHidden || columnOn(settings, c)));
  const more = $derived(ordered.filter((c) => c.defaultHidden && !columnOn(settings, c)));
  // Hidden: the usual columns the user turned off; the extra ones are not
  // "hidden" while they are off.
  const hiddenCount = $derived(columns.filter((c) => !c.defaultHidden && !columnOn(settings, c)).length);
  const allCustom = $derived(settings.custom ?? []);
  const customById = $derived(new Map(allCustom.map((c) => [customKey(c.id), c])));
  const changed = $derived(columnsChanged(settings, columns));

  // A search box once the list is long.
  const SEARCH_FROM = 9;
  const needle = $derived(search.trim().toLowerCase());
  const matches = (c: Column) => !needle || c.label.toLowerCase().includes(needle) || c.key.includes(needle);

  // While open it handles its own keys (Esc), like a context menu.
  $effect(() => {
    if (!open) return;
    untrack(() => (keyboard.menus += 1));
    return () => {
      untrack(() => (keyboard.menus -= 1));
    };
  });

  // "Columns…" in a header's right-click menu opens it.
  let seenRequest = untrack(() => chooserRequest.nonce);
  $effect(() => {
    const n = chooserRequest.nonce;
    if (n === seenRequest) return;
    seenRequest = n;
    if (untrack(() => chooserRequest.kindId) === kind.id) void untrack(() => show());
  });

  async function show() {
    open = true;
    search = "";
    draft = null;
    await tick();
    root?.querySelector<HTMLInputElement>(".popover input:not(:disabled)")?.focus();
  }

  function hide(focusTrigger = false) {
    open = false;
    draft = null;
    if (focusTrigger) trigger?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    if (draft) {
      draft = null;
      void tick().then(() => root?.querySelector<HTMLElement>(".add")?.focus());
    } else hide(true);
  }

  function onOutside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) hide();
  }

  /** Turn `col` on or off; an extra column moves between the lists, so
   *  its checkbox gets the focus back where it lands. */
  function toggle(col: Column) {
    updateKind(kind.id, toggleColumn(settings, col));
    void tick().then(() =>
      root?.querySelector<HTMLInputElement>(`[data-col="${CSS.escape(col.key)}"] input`)?.focus(),
    );
  }

  // ---- Order ----

  const orderKeys = () => ordered.map((c) => c.key);

  function say(col: Column) {
    const at = listed.findIndex((c) => c.key === col.key);
    announce = `${col.label}: position ${at + 1} of ${listed.length}`;
  }

  /** Alt+↑/↓ on a column's checkbox moves it past the next listed one. */
  function onItemKey(e: KeyboardEvent, col: Column) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const at = listed.findIndex((c) => c.key === col.key);
    const other = listed[at + (e.key === "ArrowUp" ? -1 : 1)];
    if (!other) return;
    const keys = orderKeys();
    const to = keys.indexOf(other.key);
    updateKind(kind.id, { order: moveKey(keys, col.key, to - keys.indexOf(col.key)) });
    void tick().then(() => {
      say(col);
      root?.querySelector<HTMLInputElement>(`[data-col="${CSS.escape(col.key)}"] input`)?.focus();
    });
  }

  // Dragging by the handle (pointer events: HTML drag and drop is not
  // dependable in every webview).
  let dragging = $state<{ key: string; over: number } | null>(null);
  let listEl: HTMLUListElement | undefined = $state();

  function dropIndex(y: number): number {
    const items = [...(listEl?.querySelectorAll<HTMLElement>("li[data-col]") ?? [])];
    const i = items.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? items.length : i;
  }

  function startDrag(e: PointerEvent, col: Column) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = { key: col.key, over: dropIndex(e.clientY) };
  }

  function moveDrag(e: PointerEvent) {
    if (dragging) dragging = { ...dragging, over: dropIndex(e.clientY) };
  }

  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    const { key, over } = dragging;
    dragging = null;
    if (e.type === "pointercancel") return;
    // Before the listed column at `over` (or after the last one).
    const visible = listed.filter(matches);
    const keys = orderKeys();
    const target = visible[over];
    const without = keys.filter((k) => k !== key);
    const to = target
      ? target.key === key
        ? keys.indexOf(key)
        : without.indexOf(target.key)
      : without.indexOf(visible[visible.length - 1]?.key ?? key) + 1;
    const next = moveTo(keys, key, to);
    if (next.join() !== keys.join()) {
      updateKind(kind.id, { order: next });
      const col = columns.find((c) => c.key === key);
      if (col) void tick().then(() => say(col));
    }
  }

  // ---- Custom columns ----

  interface Draft {
    /** The column edited, or null for a new one. */
    id: string | null;
    label: string;
    source: CustomSource;
    value: string;
    /** Add was pressed: say what is wrong. */
    tried: boolean;
  }
  let draft = $state<Draft | null>(null);

  const draftError = $derived(
    draft
      ? customColumnError(
          draft,
          columns.filter((c) => !draft || c.key !== customKey(draft.id ?? "")).map((c) => c.label),
        )
      : "",
  );
  /** Said while typing once there is something to check; all of it after Add. */
  const shownError = $derived(draft && (draft.tried || draft.value.trim()) ? draftError : "");

  async function startDraft(c: CustomColumn | null) {
    draft = c
      ? { id: c.id, label: c.label, source: c.source, value: c.value, tried: false }
      : { id: null, label: "", source: "label", value: "", tried: false };
    await tick();
    root?.querySelector<HTMLInputElement>(".draft input")?.focus();
  }

  async function saveDraft(e: SubmitEvent) {
    e.preventDefault();
    if (!draft) return;
    if (draftError) {
      draft.tried = true;
      return;
    }
    const value = { label: draft.label.trim(), source: draft.source, value: draft.value.trim() };
    const id = draft.id;
    const custom: CustomColumn[] =
      id === null
        ? [...allCustom, { id: newCustomId(allCustom), ...value, context: kind.crd ? currentContextName() : "" }]
        : allCustom.map((c) => (c.id === id ? { ...c, ...value } : c));
    updateKind(kind.id, { custom });
    draft = null;
    await tick();
    root?.querySelector<HTMLElement>(".add")?.focus();
  }

  function removeCustom(c: CustomColumn) {
    const key = customKey(c.id);
    updateKind(kind.id, {
      custom: allCustom.filter((x) => x.id !== c.id),
      hidden: settings.hidden.filter((k) => k !== key),
      order: (settings.order ?? []).filter((k) => k !== key),
    });
    void tick().then(() => root?.querySelector<HTMLElement>(".add")?.focus());
  }
</script>

<!-- On the window: a checkbox that moves between the lists loses the focus. -->
<svelte:window onpointerdown={onOutside} onkeydown={onKey} />

<div class="chooser" bind:this={root}>
  <button
    type="button"
    class="btn trigger"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={`Columns${hiddenCount ? ` (${hiddenCount} hidden)` : ""}`}
    title="Show, hide and order columns"
    bind:this={trigger}
    onclick={() => (open ? hide() : show())}
    ><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"
      ><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M10 2.5v11" /></svg
    ><span class="label">Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ""}</span
    >{#if hiddenCount}<span class="count" data-count={hiddenCount}></span>{/if}</button
  >
  {#if open}
    <div class="popover" role="dialog" aria-label="Columns">
      {#if draft}
        <form class="draft" onsubmit={saveDraft} novalidate>
          <div class="title">{draft.id === null ? "Add a column" : "Edit column"}</div>
          <label class="field"
            >Name
            <input type="text" bind:value={draft.label} placeholder="Version" maxlength={64} spellcheck="false" />
          </label>
          <label class="field"
            >From
            <select bind:value={draft.source}>
              {#each Object.entries(SOURCE_LABELS) as [value, label] (value)}
                <option {value}>{label}</option>
              {/each}
            </select>
          </label>
          <label class="field"
            >{draft.source === "field" ? "Path" : "Key"}
            <input
              type="text"
              class="mono"
              bind:value={draft.value}
              placeholder={SOURCE_HINTS[draft.source]}
              spellcheck="false"
              autocapitalize="off"
              aria-invalid={shownError ? "true" : undefined}
              aria-describedby="column-draft-error"
            />
          </label>
          <p class="error" id="column-draft-error" role={draft.tried ? "alert" : undefined}>{shownError}</p>
          <div class="buttons">
            <button type="button" class="btn" onclick={() => (draft = null)}>Cancel</button>
            <button type="submit" class="btn primary">{draft.id === null ? "Add" : "Save"}</button>
          </div>
        </form>
      {:else}
        {#if columns.length >= SEARCH_FROM}
          <input
            type="search"
            class="search"
            placeholder="Find a column"
            aria-label="Find a column"
            bind:value={search}
          />
        {/if}
        {#snippet choice(col: Column, movable: boolean)}
          {@const custom = customById.get(col.key)}
          <li
            data-col={col.key}
            class:extra={!movable}
            class:dragged={dragging?.key === col.key}
            class:drop-before={dragging && movable && listed.filter(matches)[dragging.over]?.key === col.key}
          >
            {#if movable}
              <!-- A pointer aid; Alt+↑/↓ on the checkbox does the same. -->
              <span
                class="handle"
                aria-hidden="true"
                title="Drag to move (or Alt+↑/↓)"
                data-testid="column-handle"
                onpointerdown={(e) => startDrag(e, col)}
                onpointermove={moveDrag}
                onpointerup={endDrag}
                onpointercancel={endDrag}
                ><svg viewBox="0 0 16 16" width="12" height="12"
                  ><circle cx="6" cy="4" r="1.1" /><circle cx="10" cy="4" r="1.1" /><circle cx="6" cy="8" r="1.1" /><circle
                    cx="10"
                    cy="8"
                    r="1.1"
                  /><circle cx="6" cy="12" r="1.1" /><circle cx="10" cy="12" r="1.1" /></svg
                ></span
              >
            {/if}
            <label title={custom ? customSourceText(custom) : undefined}>
              <input
                type="checkbox"
                checked={columnOn(settings, col)}
                disabled={ALWAYS_SHOWN.includes(col.key)}
                aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onchange={() => toggle(col)}
                onkeydown={(e) => movable && onItemKey(e, col)}
              />
              <span class="name">{col.label}</span>
            </label>
            {#if custom}
              <button
                type="button"
                class="icon-btn"
                aria-label={`Edit column ${col.label}`}
                title="Edit"
                onclick={() => startDraft(custom)}
                ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
                  ><path d="M3 13l1-3.5 6.5-6.5 2.5 2.5-6.5 6.5zM9.5 4l2.5 2.5" /></svg
                ></button
              >
              <button
                type="button"
                class="icon-btn"
                aria-label={`Remove column ${col.label}`}
                title="Remove"
                onclick={() => removeCustom(custom)}
                ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
                  ><path d="M4 4l8 8M12 4l-8 8" /></svg
                ></button
              >
            {/if}
          </li>
        {/snippet}
        <ul class="list" bind:this={listEl} aria-label="Table columns, in order">
          {#each listed.filter(matches) as col (col.key)}{@render choice(col, true)}{/each}
        </ul>
        {#if more.some(matches)}
          <div class="group" role="presentation">More columns</div>
          <ul class="list" aria-label="More columns">
            {#each more.filter(matches) as col (col.key)}{@render choice(col, false)}{/each}
          </ul>
        {/if}
        {#if needle && !listed.some(matches) && !more.some(matches)}
          <p class="none">No column matches “{search.trim()}”.</p>
        {/if}
        <div class="footer">
          <button
            type="button"
            class="btn add"
            disabled={allCustom.length >= MAX_CUSTOM}
            title={allCustom.length >= MAX_CUSTOM
              ? `A table can have at most ${MAX_CUSTOM} custom columns`
              : "A column from a label, an annotation or a field"}
            onclick={() => startDraft(null)}>+ Add column…</button
          >
          {#if changed}
            <!-- Back to what a fresh install shows: every usual column, none of the extra ones, in order. -->
            <button type="button" class="btn reset" onclick={() => updateKind(kind.id, DEFAULT_COLUMNS)}
              >Reset to default</button
            >
          {/if}
        </div>
      {/if}
      <div class="sr-only" aria-live="polite">{announce}</div>
    </div>
  {/if}
</div>

<style>
  .chooser {
    position: relative;
    flex-shrink: 0;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .icon,
  .count {
    display: none;
  }
  .icon {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  /* A narrow toolbar (the detail panel open): the icon and the hidden
     count; the name is in the tooltip and the accessible name. */
  @container toolbar (max-width: 720px) {
    .icon {
      display: block;
    }
    .count {
      display: inline;
    }
    /* From CSS, so the button's text stays "Columns (n hidden)". */
    .count::after {
      content: attr(data-count);
    }
    .label {
      display: none;
    }
  }
  .popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    width: 260px;
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .search {
    margin-bottom: 4px;
    width: 100%;
    box-sizing: border-box;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 4px;
    border-top: 2px solid transparent;
  }
  li:hover {
    background: var(--bg-hover);
  }
  li.dragged {
    opacity: 0.5;
  }
  li.drop-before {
    border-top-color: var(--accent);
  }
  .handle {
    display: inline-flex;
    align-items: center;
    padding: 4px 2px;
    color: var(--text-muted);
    cursor: grab;
    touch-action: none;
  }
  .handle svg {
    fill: currentColor;
  }
  label {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .handle + label {
    padding-left: 2px;
  }
  /* In line with the names above, past their handles. */
  li.extra label {
    padding-left: 22px;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    background: var(--bg-raised);
    color: var(--text);
  }
  .icon-btn svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .group {
    margin-top: 6px;
    padding: 6px 6px 2px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .none {
    margin: 4px 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  /* Always in view while the list scrolls. */
  .footer {
    position: sticky;
    bottom: -8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0 -8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  .draft {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px;
  }
  .title {
    font-size: 13px;
    font-weight: 600;
  }
  .field {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    padding: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .field input,
  .field select {
    font-size: 13px;
    color: var(--text);
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .error {
    margin: 0;
    min-height: 1em;
    font-size: 12px;
    color: var(--error-text);
    white-space: normal;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
