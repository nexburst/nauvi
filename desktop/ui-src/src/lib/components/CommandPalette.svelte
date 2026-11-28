<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { completeQuery, rankItems, withReasons } from "../palette";
  import { visibleCluster } from "../cluster";
  import type { Ranked } from "../palette";
  import { reloadNamespaces } from "../stores/app.svelte";
  import { activeTable, closePalette, keyboard } from "../stores/keyboard.svelte";
  import { paletteAccess, paletteItems, recentIds, rememberPick } from "../stores/palette.svelte";
  import { isTab } from "../keys";

  /** Ctrl/Cmd+K: fuzzy search over kinds, namespaces, contexts, objects and actions. */

  // Built once per opening: the palette is remounted every time. Built
  // again if listing the namespaces finds new ones (#177).
  let items = $state.raw(paletteItems());
  // The actions RBAC or a read-only context refuses (#349), by item id:
  // offered until the check answers (cached in the backend, so at once).
  let reasons = $state.raw(new Map<string, string>());
  // svelte-ignore state_referenced_locally
  const access = paletteAccess(items);
  // The cluster its actions are about.
  const openedOn = visibleCluster();
  // svelte-ignore state_referenced_locally
  let query = $state(keyboard.paletteQuery);
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  // The item Tab completed to: it stays highlighted in the new results.
  let keep: string | null = null;

  const results: Ranked[] = $derived(rankItems(withReasons(items, reasons), query, recentIds()));

  $effect(() => {
    void query;
    const id = keep;
    keep = null;
    active = id ? Math.max(0, untrack(() => results.findIndex((r) => r.item.id === id))) : 0;
  });

  // Keep the active option in view.
  $effect(() => {
    listEl?.querySelector(`#palette-option-${active}`)?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => {
    const before = document.activeElement as HTMLElement | null;
    input?.focus();
    void access.then((r) => {
      if (keyboard.palette) reasons = r;
    });
    void reloadNamespaces().then((changed) => {
      if (changed && keyboard.palette) items = paletteItems();
    });
    return () => {
      // Back to where the user was, unless what ran (a dialog) took focus.
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        if (before?.isConnected && before !== document.body) before.focus({ preventScroll: true });
        else activeTable()?.focus();
      });
    };
  });

  async function run(r: Ranked | undefined) {
    if (!r || r.item.reason) return;
    // Picked before the check answered: wait for it, unless the window
    // switched cluster meanwhile (the entry is about the old one).
    if (r.item.access) {
      const refused = await access;
      if (visibleCluster() !== openedOn) {
        closePalette();
        return;
      }
      if (refused.has(r.item.id)) {
        reasons = refused;
        return;
      }
    }
    rememberPick(r.item.id);
    closePalette();
    r.item.run();
  }

  /** Tab: complete to the highlighted result, else move like the arrows (#591). */
  function tab(back: boolean) {
    const n = results.length;
    if (!n) return;
    const r = results[active];
    const done = back || !r ? null : completeQuery(query, r.item);
    if (done !== null) {
      keep = r.item.id;
      query = done;
    } else active = (active + (back ? n - 1 : 1)) % n;
  }

  // The focus stays in the palette (an aria-modal dialog): should it leave
  // the input (a click on the palette's padding), it comes back (#591).
  function onblur(e: FocusEvent) {
    const to = e.relatedTarget;
    if (to instanceof Node && box?.contains(to)) return;
    setTimeout(() => {
      if (keyboard.palette && input?.isConnected && document.activeElement !== input) input.focus();
    });
  }

  function onkeydown(e: KeyboardEvent) {
    const n = results.length;
    switch (isTab(e) ? "Tab" : e.key) {
      case "Tab":
        tab(e.shiftKey);
        break;
      case "Escape":
        closePalette();
        break;
      case "ArrowDown":
        if (n) active = (active + 1) % n;
        break;
      case "ArrowUp":
        if (n) active = (active - 1 + n) % n;
        break;
      case "PageDown":
        if (n) active = Math.min(active + 8, n - 1);
        break;
      case "PageUp":
        if (n) active = Math.max(active - 8, 0);
        break;
      case "Enter":
        void run(results[active]);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && closePalette()}>
  <div bind:this={box} class="palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette">
    <input
      bind:this={input}
      bind:value={query}
      class="input"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="palette-list"
      aria-autocomplete="list"
      aria-activedescendant={results.length ? `palette-option-${active}` : undefined}
      aria-label="Search kinds, objects, namespaces, contexts and actions"
      placeholder="Go to…   > actions   ns namespaces   ctx contexts"
      spellcheck="false"
      autocomplete="off"
      {onkeydown}
      {onblur}
    />
    <ul id="palette-list" role="listbox" aria-label="Results" bind:this={listEl}>
      {#each results as r, i (r.item.id)}
        {#if i === 0 || results[i - 1].group !== r.group}
          <li class="group" role="presentation">{r.group}</li>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="palette-option-{i}"
          role="option"
          aria-selected={i === active}
          aria-disabled={r.item.reason ? "true" : undefined}
          aria-describedby={r.item.reason ? `palette-deny-${i}` : undefined}
          title={r.item.reason || undefined}
          class:active={i === active}
          class:denied={!!r.item.reason}
          onmousemove={() => (active = i)}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => void run(r)}
        >
          <span class="label">{r.item.label}</span>
          {#if r.item.detail}<span class="detail">{r.item.detail}</span>{/if}
          {#if r.group === "Recent" || r.item.keys}
            <span class="end">
              {#if r.group === "Recent"}<span class="tag">{r.item.group}</span>{/if}
              {#if r.item.keys}<kbd data-testid="palette-keys">{r.item.keys}</kbd>{/if}
            </span>
          {/if}
          {#if r.item.reason}
            <span class="reason" id="palette-deny-{i}" data-testid="palette-reason">{r.item.reason}</span>
          {/if}
        </li>
      {:else}
        <li class="none" role="presentation">No matches</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 120;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .palette {
    width: min(560px, calc(100vw - 32px));
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .input {
    margin: 10px;
    font-size: 14px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 6px 6px;
    max-height: 50vh;
    overflow-y: auto;
  }
  li[role="option"] {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
  }
  li.active {
    background: var(--bg-hover);
  }
  li.denied {
    flex-wrap: wrap;
    cursor: default;
  }
  li.denied .label {
    color: var(--text-muted);
  }
  .reason {
    flex-basis: 100%;
    font-size: 11px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .group {
    padding: 8px 10px 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail,
  .tag {
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .end {
    margin-left: auto;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  kbd {
    font-family: var(--font-num);
    font-size: 10.5px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 5px;
    /* No taller than the label: rows with a key keep the same height. */
    line-height: 1.2;
    white-space: nowrap;
  }
  .none {
    padding: 10px;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
