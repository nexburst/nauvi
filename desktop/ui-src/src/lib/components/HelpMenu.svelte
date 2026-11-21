<script lang="ts">
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
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-5h2v2h-2v-2zm1-10a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z"
    />
  </svg>
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
