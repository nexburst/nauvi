<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { askAiAvailable, openAskAi } from "../stores/askAi.svelte";
  import { app } from "../stores/app.svelte";

  /** The header's Ask AI (#376), about the cluster or the one namespace
   *  selected. Only shown when an AI CLI was found or a command is set.
   *  Accented (`.ai-action`, #607): the one action of its kind up there. */
  const one = $derived(app.selectedNamespaces.length === 1 ? app.selectedNamespaces[0] : "");
</script>

{#if askAiAvailable() && app.contexts.length > 0}
  <button
    class="ask-ai ai-action"
    type="button"
    data-testid="ask-ai-header"
    title={one
      ? `Ask your AI CLI about namespace ${one}, with the nauvi skill`
      : "Ask your AI CLI about this cluster, with the nauvi skill"}
    onclick={() => openAskAi()}
  >
    <Icon name="sparkles" size={15} />
    <span>Ask AI</span>
  </button>
{/if}

<style>
  /* Colours: `.ai-action` (app.css). */
  .ask-ai {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 7px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
</style>
