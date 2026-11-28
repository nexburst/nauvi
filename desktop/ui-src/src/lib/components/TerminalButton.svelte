<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { isMacPlatform, shortcutHint } from "../keys";
  import { openLocalShell } from "../stores/localShell";

  /** The header's Terminal (#592): a new local terminal at the app's
   *  context and namespace, in the dock (shown if it was hidden). */
  const SHORTCUT = shortcutHint("newLocalShell", isMacPlatform());
</script>

<button
  class="terminal"
  type="button"
  data-testid="terminal-header"
  title={`New local terminal, kubectl at this context and namespace (${SHORTCUT})`}
  onclick={openLocalShell}
>
  <Icon name="terminal" size={15} />
  <span>Terminal</span>
</button>

<style>
  .terminal {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 3px 8px;
    border-radius: 7px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .terminal:hover {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }
</style>
