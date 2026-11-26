<script lang="ts" module>
  import type { IconName } from "../icons/icons";

  export type QuickVerb = "logs" | "shell" | "edit";
  export interface Quick {
    verb: QuickVerb;
    label: string;
    /** Its key on a focused row (keys.ts), for the tooltip. */
    key: string;
    icon: IconName;
  }
</script>

<script lang="ts">
  import Icon from "../icons/Icon.svelte";

  /** A row's own actions on hover (#482), so the ⋮ menu is not the only
   *  way to them. Drawn over the end of the row's last cell, in the row's
   *  tint, beside its ⋮ (inside the sticky ⋮ cell). */
  let { name, items, run }: { name: string; items: Quick[]; run: (e: MouseEvent, verb: QuickVerb) => void } = $props();
</script>

<div class="quick" data-testid="row-quick">
  {#each items as q (q.verb)}
    <button
      type="button"
      class="quick-btn"
      tabindex="-1"
      data-testid="row-{q.verb}"
      aria-label="{q.label} of {name}"
      title="{q.label} ({q.key})"
      onclick={(e) => run(e, q.verb)}><Icon name={q.icon} size={15} /></button
    >
  {/each}
</div>

<style>
  .quick {
    position: absolute;
    right: 100%;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 14px;
    background:
      linear-gradient(var(--row-bg, transparent), var(--row-bg, transparent)),
      var(--bg);
    /* Fades in over the cell it covers. */
    -webkit-mask-image: linear-gradient(to right, transparent, #000 12px);
    mask-image: linear-gradient(to right, transparent, #000 12px);
  }
  .quick-btn {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    border-radius: 5px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .quick-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }
</style>
