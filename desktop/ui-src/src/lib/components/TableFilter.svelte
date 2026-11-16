<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../stores/app.svelte";
  import { keyboard } from "../stores/keyboard.svelte";
  import {
    currentSearch,
    filterError,
    forgetSearch,
    rememberSearch,
    searchHistory,
    starSearch,
    tableFilter,
    useSearch,
  } from "../stores/tableFilter.svelte";
  import { isStarred, keptSearch, searchLabel, suggestions } from "../searchHistory";
  import type { SavedSearch, Suggestion } from "../searchHistory";

  /**
   * The toolbar's filter (#219): the text box shared by every list, match
   * case and regex toggles, a star for the search in the box, and the
   * recent and starred searches offered under it (ArrowDown, or typing).
   */

  let input: HTMLInputElement | undefined = $state();
  let open = $state(false);
  /** The highlighted suggestion, -1 for none. */
  let active = $state(-1);

  const error = $derived(filterError());
  const current = $derived(currentSearch());
  const items = $derived(suggestions(searchHistory(), app.search, current));
  const shown = $derived(open && items.length > 0);
  const starred = $derived(isStarred(searchHistory(), current));
  const canStar = $derived(keptSearch(current) !== null && error === "");

  // While open it handles its own keys (Esc), like a context menu.
  $effect(() => {
    if (!shown) return;
    untrack(() => (keyboard.menus += 1));
    return () => {
      untrack(() => (keyboard.menus -= 1));
    };
  });

  function close() {
    open = false;
    active = -1;
  }

  function pick(s: SavedSearch) {
    useSearch(s);
    rememberSearch();
    close();
    input?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) {
        open = true;
        active = e.key === "ArrowDown" ? 0 : items.length - 1;
        return;
      }
      const n = items.length;
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown && active >= 0 && items[active]) pick(items[active].search);
      else {
        rememberSearch();
        close();
      }
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onInput() {
    open = true;
    active = -1;
  }

  function toggle(which: "case" | "regex") {
    if (which === "case") tableFilter.matchCase = !tableFilter.matchCase;
    else tableFilter.regex = !tableFilter.regex;
  }

  /** Buttons in the list keep the focus in the box (so it does not blur and close). */
  const keepFocus = (e: MouseEvent) => e.preventDefault();

  const optionId = (i: number) => `table-filter-option-${i}`;
  const rowLabel = (s: Suggestion) =>
    `${searchLabel(s.search)}${s.search.match_case ? " (match case)" : ""}${s.starred ? " (starred)" : ""}`;
</script>

<div class="filter" data-testid="table-filter-box">
  <div class="field">
    <input
      id="table-filter"
      class="input search"
      class:invalid={error !== ""}
      type="search"
      placeholder={tableFilter.regex ? "Filter (regex)…" : "Filter…"}
      aria-label="Filter"
      aria-invalid={error !== "" ? "true" : undefined}
      aria-controls={shown ? "table-filter-suggestions" : undefined}
      aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
      autocomplete="off"
      spellcheck="false"
      bind:this={input}
      bind:value={app.search}
      oninput={onInput}
      onkeydown={onKey}
      onblur={() => {
        rememberSearch();
        close();
      }}
    />
    {#if shown}
      <ul class="suggestions" id="table-filter-suggestions" role="listbox" aria-label="Saved searches">
        {#each items as s, i (searchLabel(s.search) + s.search.match_case + s.starred)}
          <!-- The arrows and Enter in the box pick an option (aria-activedescendant). -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            class="option"
            class:active={i === active}
            role="option"
            aria-selected={i === active}
            aria-label={rowLabel(s)}
            onmousedown={keepFocus}
            onclick={() => pick(s.search)}
            onmouseenter={() => (active = i)}
          >
            <span class="mark" aria-hidden="true">{s.starred ? "★" : "↺"}</span>
            <span class="text" class:mono={s.search.regex}>{searchLabel(s.search)}</span>
            {#if s.search.match_case}<span class="tag" title="Match case">Aa</span>{/if}
            <button
              type="button"
              class="row-btn"
              title={s.starred ? "Unstar" : "Star"}
              aria-label={s.starred ? `Unstar ${searchLabel(s.search)}` : `Star ${searchLabel(s.search)}`}
              onmousedown={keepFocus}
              onclick={(e) => {
                e.stopPropagation();
                starSearch(s.search);
              }}>{s.starred ? "★" : "☆"}</button
            >
            {#if !s.starred}
              <button
                type="button"
                class="row-btn"
                title="Remove from recent searches"
                aria-label={`Remove ${searchLabel(s.search)}`}
                onmousedown={keepFocus}
                onclick={(e) => {
                  e.stopPropagation();
                  forgetSearch(s.search);
                }}>✕</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <button
    type="button"
    class="btn toggle"
    class:active={tableFilter.matchCase}
    aria-pressed={tableFilter.matchCase}
    title="Match case"
    aria-label="Match case"
    onclick={() => toggle("case")}>Aa</button
  >
  <button
    type="button"
    class="btn toggle mono"
    class:active={tableFilter.regex}
    aria-pressed={tableFilter.regex}
    title="Regular expression"
    aria-label="Regular expression"
    onclick={() => toggle("regex")}>.*</button
  >
  <button
    type="button"
    class="btn toggle star"
    class:active={starred}
    aria-pressed={starred}
    title={starred ? "Unstar this search" : "Star this search: it stays in the suggestions"}
    aria-label="Star this search"
    disabled={!canStar}
    onclick={() => starSearch(current)}>{starred ? "★" : "☆"}</button
  >
  {#if error}
    <span class="error" role="alert" data-testid="table-filter-error" title={error}>{error}</span>
  {/if}
</div>

<style>
  .filter {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 auto;
    min-width: 0;
  }
  .field {
    position: relative;
    flex: 0 1 220px;
    min-width: 120px;
  }
  .search {
    width: 100%;
    box-sizing: border-box;
  }
  .search.invalid {
    border-color: var(--red);
  }
  .toggle {
    padding: 4px 8px;
    line-height: 1.2;
    flex-shrink: 0;
  }
  .toggle:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  /* Its own width (up to a limit): the toolbar wraps before it is cut. */
  .error {
    flex: none;
    color: var(--red);
    font-size: 12px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .suggestions {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    min-width: 100%;
    max-width: 420px;
    max-height: 50vh;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .option {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px 3px 8px;
    font-size: 13px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .option.active {
    background: var(--bg-hover);
  }
  .mark {
    color: var(--text-muted);
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 3px;
    flex-shrink: 0;
  }
  .row-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 4px;
    flex-shrink: 0;
  }
  .row-btn:hover {
    color: var(--text);
  }
</style>
