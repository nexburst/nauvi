<script lang="ts">
  // The Pods table's Containers cell (#379): one square per container, init
  // containers first and set apart by a thin rule. Each square has its own
  // shape for its state (see `Look`), its colour, and a tooltip; the cell's
  // text alternative names every container for screen readers.
  import { containersSummary, lookTone, parseContainers, squareText } from "../containerStates";

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
      <svg viewBox="0 0 10 10" width="10" height="10">
        {#if s.look === "ok"}
          <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="currentColor" />
        {:else if s.look === "warn"}
          <rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <rect x="1" y="5" width="8" height="4" fill="currentColor" />
        {:else if s.look === "bad"}
          <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="currentColor" />
          <path d="M3 3 L7 7 M7 3 L3 7" class="cut" stroke-width="1.5" stroke-linecap="round" />
        {:else if s.look === "done"}
          <rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
        {:else}
          <rect
            x="1"
            y="1"
            width="8"
            height="8"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-dasharray="2 1.5"
          />
        {/if}
      </svg>
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
  /* Init containers are a touch smaller, and the rule sets them apart. */
  .sq.init svg {
    width: 8px;
    height: 8px;
  }
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
  /* The cross is cut out of the red square in the row's background. */
  .cut {
    stroke: var(--bg-raised);
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
