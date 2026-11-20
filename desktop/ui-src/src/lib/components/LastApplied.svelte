<script lang="ts">
  import { hasMasked, prettyJson, sizeText } from "../lastApplied";

  /** kubectl's last-applied-configuration annotation, collapsed until asked
   *  for: it repeats the whole object. `value` comes masked from the backend. */
  let { value }: { value: string } = $props();

  let open = $state(false);
  const size = $derived(sizeText(value));
  const text = $derived(open ? prettyJson(value) : "");
</script>

<div class="row" data-testid="last-applied">
  <span class="muted">last-applied-configuration · {size} ·</span>
  <button
    type="button"
    class="link"
    aria-expanded={open}
    data-testid="last-applied-toggle"
    onclick={() => (open = !open)}>{open ? "Hide" : "Show"}</button
  >
</div>
{#if open}
  {#if hasMasked(value)}
    <div class="note muted" data-testid="last-applied-masked">Values that look like secrets are hidden (••••).</div>
  {/if}
  <pre class="mono" data-testid="last-applied-text">{text}</pre>
{/if}

<style>
  .row {
    font-family: inherit;
    font-size: 12px;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .note {
    font-size: 12px;
    margin-top: 4px;
  }
  pre {
    margin: 4px 0 0;
    padding: 6px 8px;
    max-height: 20em;
    overflow: auto;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    white-space: pre;
    word-break: normal;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .muted {
    color: var(--text-muted);
  }
</style>
