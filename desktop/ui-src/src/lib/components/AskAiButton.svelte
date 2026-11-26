<script lang="ts">
  import { askAiAvailable, openAskAi } from "../stores/askAi.svelte";
  import { app } from "../stores/app.svelte";

  /** The header's Ask AI (#376), about the cluster or the one namespace
   *  selected. Only shown when an AI CLI was found or a command is set. */
  const one = $derived(app.selectedNamespaces.length === 1 ? app.selectedNamespaces[0] : "");
</script>

{#if askAiAvailable() && app.contexts.length > 0}
  <button
    class="ask-ai"
    type="button"
    data-testid="ask-ai-header"
    title={one
      ? `Ask your AI CLI about namespace ${one}, with the nauvi skill`
      : "Ask your AI CLI about this cluster, with the nauvi skill"}
    onclick={() => openAskAi()}
  >
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
    <span>Ask AI</span>
  </button>
{/if}

<style>
  .ask-ai {
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
  .ask-ai:hover {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }
</style>
