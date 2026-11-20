<script lang="ts">
  // One state square (#379): filled (ok), half filled (warn), filled with a
  // cross (bad), hollow (done), dashed (unknown). Drawn in `currentColor`, so
  // the parent sets the tone. Shared by the container squares and the
  // workload Status cell (#381).
  import type { Look } from "../containerStates";

  let { look, size = 10 }: { look: Look; size?: number } = $props();
</script>

<svg viewBox="0 0 10 10" width={size} height={size} aria-hidden="true">
  {#if look === "ok"}
    <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="currentColor" />
  {:else if look === "warn"}
    <rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    <rect x="1" y="5" width="8" height="4" fill="currentColor" />
  {:else if look === "bad"}
    <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="currentColor" />
    <path d="M3 3 L7 7 M7 3 L3 7" class="cut" stroke-width="1.5" stroke-linecap="round" />
  {:else if look === "done"}
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

<style>
  svg {
    flex-shrink: 0;
  }
  /* The cross is cut out of the red square in the row's background. */
  .cut {
    stroke: var(--bg-raised);
  }
</style>
