<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Icon from "../icons/Icon.svelte";
  import { issueShort, objectsText, oneLine } from "../askAi";
  import { AI_CONTEXT_MAX, objectKey } from "../aiContext";
  import { keyboard } from "../stores/keyboard.svelte";
  import { aiContextList, aiContextPanel, clearAiContext, removeFromAiContext } from "../stores/aiContext.svelte";
  import { openAskAiAbout } from "../stores/askAi.svelte";

  /** The AI context list (#608), opened from the count of the header's Ask
   *  AI: each object with the reason nauvi showed, removable one by one,
   *  and the Ask AI that names them all. */
  const list = $derived(aiContextList());

  function close() {
    aiContextPanel.open = false;
  }

  // Open, it handles its own keys (Esc closes it), like a menu.
  onMount(() => {
    keyboard.menus += 1;
  });
  onDestroy(() => {
    keyboard.menus -= 1;
  });
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function ask() {
    close();
    openAskAiAbout();
  }

  const subject = (o: (typeof list)[number]) =>
    `${oneLine(o.kind)} ${o.namespace ? `${oneLine(o.namespace)}/` : ""}${oneLine(o.name)}`;
</script>

<svelte:window {onkeydown} />
<button type="button" class="scrim" aria-label="Close" tabindex="-1" onclick={close}></button>
<div class="panel" role="dialog" aria-label="Ask AI list" data-testid="ai-context-panel">
  <div class="head">
    <h3>Ask AI list</h3>
    <span class="muted num">{list.length} of {AI_CONTEXT_MAX}</span>
  </div>
  <p class="muted note">Names and reasons only: the AI looks up the rest itself.</p>
  <ul class="items">
    {#each list as o (objectKey(o))}
      <li data-testid="ai-context-item">
        <span class="what">
          <span class="name" title={subject(o)}>{subject(o)}</span>
          {#if o.issue}<span class="why muted">{issueShort(o.issue)}</span>{/if}
        </span>
        <button
          type="button"
          class="remove"
          aria-label={`Remove ${subject(o)} from the list`}
          title="Remove from the list"
          data-testid="ai-context-remove"
          onclick={() => removeFromAiContext(objectKey(o))}><Icon name="close" size={13} /></button
        >
      </li>
    {/each}
  </ul>
  <div class="buttons">
    <button type="button" class="btn" data-testid="ai-context-clear" onclick={() => clearAiContext()}>Clear</button>
    <button type="button" class="btn ask ai-action" data-testid="ai-context-ask" onclick={ask}>
      <Icon name="sparkles" size={14} />Ask AI about {list.length === 1 ? "it" : `these ${list.length}`}
    </button>
  </div>
  <span class="sr" aria-live="polite">{objectsText(list.length)} in the list</span>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: transparent;
    border: none;
    cursor: default;
  }
  .panel {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 60;
    width: 380px;
    max-width: calc(100vw - 24px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: var(--shadow-pop);
    transform-origin: top right;
    animation: open 180ms var(--ease-out);
  }
  @keyframes open {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-4px);
    }
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    flex: 1;
  }
  .note {
    margin: 0;
    font-size: var(--text-xs);
  }
  .muted {
    color: var(--text-muted);
  }
  .num {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .items {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 320px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .items li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 4px 4px 8px;
    min-height: 26px;
  }
  .items li + li {
    border-top: 1px solid var(--border);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-feature-settings: "calt" 0;
  }
  .why {
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
  }
  .remove:hover,
  .remove:focus-visible {
    color: var(--red);
    background: var(--bg-hover);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ask {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
