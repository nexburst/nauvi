<script lang="ts">
  import { tick } from "svelte";
  import type { SearchAddon } from "@xterm/addon-search";
  import { initialQuery, matchLabel, searchOptions } from "../terminalSearch";
  import { shortcutHint, isMacPlatform } from "../keys";

  /** The search bar over a terminal (#222): Enter / Shift+Enter go to the
   *  next / previous match, Esc closes it and gives the terminal the focus. */
  interface Props {
    search: SearchAddon;
    /** Called after it closes (the terminal takes the focus back). */
    onclose: () => void;
  }

  let { search, onclose }: Props = $props();

  let shown = $state(false);
  let query = $state("");
  let caseSensitive = $state(false);
  let index = $state(-1);
  let count = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  const label = $derived(matchLabel(query, index, count));
  const hint = shortcutHint("terminalSearch", isMacPlatform());

  $effect(() => {
    const sub = search.onDidChangeResults((r) => {
      index = r.resultIndex;
      count = r.resultCount;
    });
    return () => sub.dispose();
  });

  /** Show the bar (or focus it again), starting from `selection` if it is one line. */
  export async function open(selection: string) {
    const start = initialQuery(selection);
    if (start) query = start;
    shown = true;
    await tick();
    input?.focus();
    input?.select();
    if (query) find(true, true);
  }

  function reset() {
    search.clearDecorations();
    index = -1;
    count = 0;
  }

  function find(forward: boolean, incremental = false) {
    if (!query) return reset();
    const opts = searchOptions(caseSensitive, incremental);
    if (forward) search.findNext(query, opts);
    else search.findPrevious(query, opts);
  }

  function close() {
    shown = false;
    reset();
    onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      find(!e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function toggleCase() {
    caseSensitive = !caseSensitive;
    // The addon only recounts when the term changes: clearing forgets it.
    search.clearDecorations();
    find(true, true);
    input?.focus();
  }
</script>

{#if shown}
  <div class="bar" role="search" data-testid="terminal-search">
    <input
      bind:this={input}
      bind:value={query}
      class="mini"
      type="text"
      placeholder="Find in terminal"
      aria-label="Find in terminal"
      title="Enter: next, Shift+Enter: previous, Esc: close ({hint})"
      spellcheck="false"
      autocomplete="off"
      oninput={() => find(true, true)}
      {onkeydown}
    />
    <span class="count" role="status" data-testid="terminal-search-count">{label}</span>
    <button
      type="button"
      class="btn icon"
      class:active={caseSensitive}
      aria-pressed={caseSensitive}
      title="Match case"
      onclick={toggleCase}>Aa</button
    >
    <button
      type="button"
      class="btn icon"
      title="Previous match (Shift+Enter)"
      aria-label="Previous match"
      disabled={count === 0}
      onclick={() => find(false)}>↑</button
    >
    <button
      type="button"
      class="btn icon"
      title="Next match (Enter)"
      aria-label="Next match"
      disabled={count === 0}
      onclick={() => find(true)}>↓</button
    >
    <button type="button" class="btn icon" title="Close (Esc)" aria-label="Close search" onclick={close}>×</button>
  </div>
{/if}

<style>
  .bar {
    position: absolute;
    top: 6px;
    right: 18px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: calc(100% - 36px);
    padding: 4px 6px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    font-size: 12px;
  }
  .mini {
    width: 200px;
    min-width: 80px;
    flex: 0 1 auto;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
  }
  .mini:focus {
    outline: none;
    border-color: var(--accent);
  }
  .count {
    min-width: 72px;
    padding: 0 4px;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: center;
  }
  .icon {
    padding: 2px 7px;
    line-height: 1.2;
  }
  .icon:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
