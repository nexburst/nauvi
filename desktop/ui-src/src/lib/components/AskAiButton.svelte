<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { askAiAvailable, openAskAi } from "../stores/askAi.svelte";
  import { aiContextList, aiContextPanel } from "../stores/aiContext.svelte";
  import { app } from "../stores/app.svelte";
  import { objectsText } from "../askAi";
  import AiContextPanel from "./AiContextPanel.svelte";

  /** The header's Ask AI (#376), about the cluster or the one namespace
   *  selected. Only shown when an AI CLI was found or a command is set.
   *  Accented (`.ai-action`, #607): the one action of its kind up there.
   *  With an AI context list (#608) it is a split button: "Ask AI | 3", the
   *  count opens the list. No chip of its own: the header has no room. */
  const one = $derived(app.selectedNamespaces.length === 1 ? app.selectedNamespaces[0] : "");
  const count = $derived(aiContextList().length);

  /** One pulse per change of the count (none while it is 0). */
  let pulses = $state(0);
  let last = 0;
  $effect(() => {
    if (count !== last && count > 0 && last > 0) pulses++;
    last = count;
  });
  $effect(() => {
    if (count === 0) aiContextPanel.open = false;
  });
</script>

{#if askAiAvailable() && app.contexts.length > 0}
  <div class="split" class:with-list={count > 0} data-testid="ask-ai-split">
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
    {#if count > 0}
      <button
        class="count ai-action"
        type="button"
        data-testid="ai-context-count"
        aria-label={`Ask AI list: ${objectsText(count)}`}
        title={`The Ask AI list: ${objectsText(count)} to ask about together`}
        aria-haspopup="dialog"
        aria-expanded={aiContextPanel.open}
        onclick={() => (aiContextPanel.open = !aiContextPanel.open)}
      >
        {#key pulses}<span class="badge" class:pulse={pulses > 0}>{count}</span>{/key}
      </button>
    {/if}
    {#if aiContextPanel.open && count > 0}<AiContextPanel />{/if}
  </div>
{/if}

<style>
  .split {
    position: relative;
    display: flex;
    align-items: stretch;
  }
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
  .with-list .ask-ai {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* The count segment: shares the button's hairline, opens the list. */
  .count {
    display: flex;
    align-items: center;
    padding: 0 5px;
    margin-left: -1px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-top-right-radius: 7px;
    border-bottom-right-radius: 7px;
    cursor: pointer;
  }
  .badge {
    display: inline-block;
    min-width: 18px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    line-height: 16px;
    text-align: center;
  }
  /* Once per change of the count; nothing under reduced motion (app.css). */
  .badge.pulse {
    animation: pulse 180ms var(--ease-out);
  }
  @keyframes pulse {
    50% {
      transform: scale(1.12);
    }
  }
</style>
