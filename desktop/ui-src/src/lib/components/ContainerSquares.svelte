<script lang="ts">
  // The Pods table's Containers cell (#379): one square per container, init
  // containers first and set apart by a thin rule. Each square has its own
  // shape for its state (see `Look`), its colour, and a tooltip; the cell's
  // text alternative names every container for screen readers.
  import { containersSummary, lookTone, parseContainers, squareText } from "../containerStates";
  import StateGlyph from "./StateGlyph.svelte";

  let { cell }: { cell: string } = $props();

  const squares = $derived(parseContainers(cell));
  const firstApp = $derived(squares.findIndex((s) => !s.init));
</script>

<span class="squares" data-testid="container-squares">
  {#each squares as s, i (i)}
    {#if i > 0 && i === firstApp}<span class="rule" aria-hidden="true"></span>{/if}
    <span
      class="sq tone-{lookTone(s.look)}"
      class:init={s.init}
      data-testid="container-square"
      data-look={s.look}
      title={squareText(s)}
      aria-hidden="true"
    >
      <StateGlyph look={s.look} size={s.init ? 8 : 10} />
    </span>
  {/each}
  <span class="sr-only">{containersSummary(squares)}</span>
</span>

<style>
  .squares {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 100%;
    overflow: hidden;
    vertical-align: middle;
  }
  .sq {
    display: inline-flex;
    flex-shrink: 0;
  }
  /* Init containers are a touch smaller (the glyph's size), and the rule
     sets them apart. */
  .rule {
    flex-shrink: 0;
    width: 1px;
    height: 10px;
    margin: 0 1px;
    background: var(--border-strong);
  }
  .tone-ok {
    color: var(--green);
  }
  .tone-warn {
    color: var(--amber);
  }
  .tone-bad {
    color: var(--red);
  }
  .tone-muted {
    color: var(--text-muted);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
