<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../stores/app.svelte";
  import { activeTable, keyboard } from "../stores/keyboard.svelte";
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
   * recent and starred searches offered under it (typing, ArrowUp or
   * Alt+ArrowDown). Enter, Esc and ArrowDown go back to the rows with the
   * filter kept (#590, k9s's `/filter` then Enter).
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

  /**
   * Leave the box for the table: its first matching row gets the keyboard
   * focus, so `j`/`k`/`d`/`l` work at once. No rows, or a list without a
   * focusable grid: the box still lets go of the focus, never traps it.
   */
  function toRows() {
    rememberSearch();
    close();
    const table = activeTable();
    if (table) {
      table.move("first");
      table.focus();
    }
    if (document.activeElement === input) input?.blur();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) {
        // ArrowDown goes to the rows; ArrowUp (or Alt+ArrowDown, as in a
        // combo box) shows the saved searches.
        if (e.key === "ArrowDown" && !e.altKey) return toRows();
        open = true;
        active = e.key === "ArrowDown" ? 0 : items.length - 1;
        return;
      }
      const n = items.length;
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown && active >= 0 && items[active]) pick(items[active].search);
      else toRows();
    } else if (e.key === "Escape") {
      // Open: only close the suggestions. Closed: back to the rows with the
      // filter kept (not cleared, as a search box does on Esc).
      e.preventDefault();
      e.stopPropagation();
      if (shown) close();
      else toRows();
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
  <!-- Labelled toggles (#483): a glyph and a word; beside the inspector
       only the glyph, the name stays in the tooltip. -->
  <button
    type="button"
    class="btn toggle"
    class:active={tableFilter.matchCase}
    aria-pressed={tableFilter.matchCase}
    title={tableFilter.matchCase ? "Match case: on (Aa ≠ aa)" : "Match case: off"}
    aria-label="Match case"
    onclick={() => toggle("case")}><span class="glyph" aria-hidden="true">Aa</span><span class="word">Match case</span></button
  >
  <button
    type="button"
    class="btn toggle"
    class:active={tableFilter.regex}
    aria-pressed={tableFilter.regex}
    title={tableFilter.regex ? "Regular expression: on, the filter is a regex" : "Regular expression: off"}
    aria-label="Regex (regular expression)"
    onclick={() => toggle("regex")}><span class="glyph mono" aria-hidden="true">.*</span><span class="word">Regex</span></button
  >
  <button
    type="button"
    class="btn toggle star"
    class:active={starred}
    aria-pressed={starred}
    title={!canStar
      ? "Star a search to keep it in the suggestions (type one first)"
      : starred
        ? "Starred: kept in the suggestions. Click to unstar."
        : "Star this search: it stays in the suggestions"}
    aria-label="Star this search"
    disabled={!canStar}
    onclick={() => starSearch(current)}
    ><span class="glyph" aria-hidden="true">{starred ? "★" : "☆"}</span><span class="word">Star</span></button
  >
  {#if error}
    <span class="error" role="alert" data-testid="table-filter-error" title={error}>{error}</span>
  {/if}
</div>

<style>
  /* The toolbar places it at its minimum (box and toggles) and lets it grow
     into the room left, so it never wraps the toolbar on its own. */
  .filter {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 0;
    min-width: 360px;
    max-width: 520px;
  }
  /* An invalid regex: room for the message (the toolbar may wrap). */
  .filter:has(.error) {
    min-width: 440px;
    max-width: 680px;
  }
  /* The message needs the room more than the toggles' words (their
     glyphs and tooltips stay). */
  .filter:has(.error) .word {
    display: none;
  }
  .field {
    position: relative;
    flex: 1 1 220px;
    min-width: 120px;
  }
  /* Beside the inspector (#392): a shorter box before the toolbar wraps. */
  @container toolbar (max-width: 720px) {
    .filter:not(:has(.error)) {
      min-width: auto;
    }
    .field {
      flex-basis: 96px;
      min-width: 96px;
    }
    .word {
      display: none;
    }
  }
  .search {
    width: 100%;
    box-sizing: border-box;
  }
  .search.invalid {
    border-color: var(--red);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    line-height: 1.2;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .glyph {
    font-weight: var(--weight-semibold);
  }
  .toggle:not(.active) .glyph {
    color: var(--text-muted);
  }
  .toggle:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  /* Up to a limit, in the room the filter has; the full text is in the
     tooltip. */
  .error {
    flex: 0 1 auto;
    min-width: 80px;
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
