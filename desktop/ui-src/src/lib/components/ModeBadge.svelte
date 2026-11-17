<script lang="ts">
  import type { ContextMode } from "../bindings";
  import { modeLabel, modeTitle } from "../contextMode";

  /** A context's read-only or protected badge (#338); nothing for normal. */
  let { mode, name }: { mode: ContextMode | undefined; name: string } = $props();
  const label = $derived(modeLabel(mode));
</script>

{#if label}
  <span
    class="mode"
    class:read-only={mode === "readOnly"}
    class:protected={mode === "protected"}
    title={modeTitle(mode, name)}
    data-testid="context-mode-badge">{label}</span
  >
{/if}

<style>
  .mode {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid currentColor;
    white-space: nowrap;
    flex-shrink: 0;
    line-height: 16px;
  }
  .read-only {
    color: var(--accent);
  }
  .protected {
    color: var(--amber);
  }
</style>
