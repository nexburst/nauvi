<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ResourceKind } from "../bindings";
  import { columnsFor } from "../columns";
  import { ALWAYS_SHOWN, columnOn, columnsChanged, DEFAULT_COLUMNS, toggleColumn } from "../settings";
  import { keyboard } from "../stores/keyboard.svelte";
  import { kindSettings, updateKind } from "../stores/settings.svelte";

  /** Show or hide the table's columns; remembered per kind. Off-by-default
   *  columns (#378) are listed apart, under "More columns". */
  let { kind }: { kind: ResourceKind } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();

  const columns = $derived(columnsFor(kind));
  const settings = $derived(kindSettings(kind.id));
  const usual = $derived(columns.filter((c) => !c.defaultHidden));
  const more = $derived(columns.filter((c) => c.defaultHidden));
  // Hidden: the usual columns the user turned off; the extra ones are not
  // "hidden" while they are off.
  const hiddenCount = $derived(usual.filter((c) => !columnOn(settings, c)).length);

  // While open it handles its own keys (Esc), like a context menu.
  $effect(() => {
    if (!open) return;
    untrack(() => (keyboard.menus += 1));
    return () => {
      untrack(() => (keyboard.menus -= 1));
    };
  });

  async function show() {
    open = true;
    await tick();
    root?.querySelector<HTMLInputElement>(".popover input:not(:disabled)")?.focus();
  }

  function hide(focusTrigger = false) {
    open = false;
    if (focusTrigger) trigger?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      hide(true);
    }
  }

  function onOutside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) hide();
  }
</script>

<svelte:window onpointerdown={onOutside} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="chooser" bind:this={root} onkeydown={onKey}>
  <button
    type="button"
    class="btn trigger"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={`Columns${hiddenCount ? ` (${hiddenCount} hidden)` : ""}`}
    title="Show or hide columns"
    bind:this={trigger}
    onclick={() => (open ? hide() : show())}
    ><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"
      ><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M10 2.5v11" /></svg
    ><span class="label">Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ""}</span
    >{#if hiddenCount}<span class="count" data-count={hiddenCount}></span>{/if}</button
  >
  {#if open}
    <div class="popover" role="dialog" aria-label="Columns">
      {#snippet choice(col: (typeof columns)[number])}
        <label>
          <input
            type="checkbox"
            checked={columnOn(settings, col)}
            disabled={ALWAYS_SHOWN.includes(col.key)}
            onchange={() => updateKind(kind.id, toggleColumn(settings, col))}
          />
          {col.label}
        </label>
      {/snippet}
      {#each usual as col (col.key)}{@render choice(col)}{/each}
      {#if more.length}
        <div class="group" role="presentation">More columns</div>
        {#each more as col (col.key)}{@render choice(col)}{/each}
      {/if}
      {#if columnsChanged(settings, columns)}
        <!-- Back to what a fresh install shows: every usual column, none of the extra ones. -->
        <button type="button" class="btn reset" onclick={() => updateKind(kind.id, DEFAULT_COLUMNS)}
          >Default columns</button
        >
      {/if}
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
    min-width: 180px;
    max-height: 60vh;
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
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    font-size: 13px;
    border-radius: 4px;
    white-space: nowrap;
  }
  label:hover {
    background: var(--bg-hover);
  }
  .reset {
    margin-top: 6px;
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
</style>
