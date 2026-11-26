<script lang="ts">
  import { ICONS, type IconName } from "./icons";

  /**
   * One icon of the set in `icons.ts`. Decorative unless it has a `title`:
   * then it is an image with that name (for an icon that stands alone).
   */
  let {
    name,
    size = 16,
    title = "",
    class: className = "",
  }: { name: IconName; size?: number; title?: string; class?: string } = $props();
</script>

<svg
  class="icon {className}"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  role={title ? "img" : undefined}
  aria-label={title || undefined}
  aria-hidden={title ? undefined : "true"}
  data-icon={name}
>
  {#if title}<title>{title}</title>{/if}
  {#each ICONS[name] as d, i (i)}<path {d} />{/each}
</svg>

<style>
  .icon {
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: var(--icon-stroke, 1.8);
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
