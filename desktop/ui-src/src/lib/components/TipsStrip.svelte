<script lang="ts">
  import { isMacPlatform } from "../keys";
  import { tips } from "../welcome";
  import { dismissTips } from "../stores/welcome.svelte";
  import Icon from "../icons/Icon.svelte";

  /** The tips strip of the first few sessions (#485): a few keys, one line, closed for good with ✕. */
  const list = tips(isMacPlatform());
</script>

<div class="tips" role="note" aria-label="Tips" data-testid="tips-strip">
  <span class="label">Tip</span>
  {#each list as t (t.keys)}
    <span class="tip"><kbd>{t.keys}</kbd>{t.text}</span>
  {/each}
  <button type="button" class="close" aria-label="Hide the tips" title="Hide the tips for good" onclick={dismissTips}>
    <Icon name="close" size={14} />
  </button>
</div>

<style>
  .tips {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
    padding: 5px 8px 5px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
  }
  .label {
    color: var(--accent);
    font-weight: var(--weight-semibold);
  }
  .tip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  kbd {
    font-family: var(--font-num);
    font-size: var(--text-xs);
    padding: 0 5px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
  }
  .close {
    margin-left: auto;
    display: inline-flex;
    padding: 3px;
    background: none;
    border: none;
    border-radius: 5px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
</style>
