<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem } from "./ContextMenu.svelte";
  import { help, openAbout, openHelpItem } from "../stores/help.svelte";

  /** The header's Help menu (#208). On macOS the menu bar's Help menu has
   *  the same items. */
  let button = $state<HTMLButtonElement | null>(null);
  let at = $state({ x: 0, y: 0 });

  const items: MenuItem[] = [
    { label: "Documentation", run: () => void openHelpItem("documentation") },
    { label: "Report a bug…", run: () => void openHelpItem("report_bug") },
    { label: "Open log folder", run: () => void openHelpItem("log_folder") },
    { label: "About nauvi", run: openAbout },
  ];

  function toggle() {
    if (help.menuOpen) {
      help.menuOpen = false;
      return;
    }
    const r = button?.getBoundingClientRect();
    // Right-aligned under the button; the menu keeps itself in the window.
    at = { x: r ? r.right - 200 : 0, y: r ? r.bottom + 8 : 0 };
    help.menuOpen = true;
  }
</script>

<button
  bind:this={button}
  class="help"
  type="button"
  aria-label="Help"
  title="Help"
  aria-haspopup="menu"
  aria-expanded={help.menuOpen}
  data-testid="help-menu-button"
  onclick={toggle}
>
  <Icon name="help" size={18} />
</button>
{#if help.menuOpen}
  <ContextMenu x={at.x} y={at.y} title="Help" {items} onclose={() => (help.menuOpen = false)} />
{/if}

<style>
  .help {
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
  }
  .help:hover,
  .help[aria-expanded="true"] {
    color: var(--text);
    background: var(--bg-hover);
  }
</style>
