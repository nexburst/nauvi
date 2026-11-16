<script lang="ts">
  import type { ExecCommand } from "../../bindings";
  import { answerPrompt } from "../../stores/catalog.svelte";

  /** Asks before an added kubeconfig's login commands run (#201): shows
   *  each command line exactly and the contexts that use it. */
  let { source, commands }: { source: string; commands: ExecCommand[] } = $props();

  const many = $derived(commands.length > 1);

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<div class="prompt" role="alertdialog" aria-label="Allow login command" data-testid="exec-prompt">
  <p>
    <strong>{source}</strong> logs in by running {many ? "these commands" : "this command"} on this computer, as you:
  </p>
  <ul>
    {#each commands as c (c.command)}
      <li>
        <code data-testid="exec-command">{c.command}</code>
        <span class="muted used">Used by {c.contexts.join(", ")}</span>
      </li>
    {/each}
  </ul>
  <p class="muted note">
    Allow {many ? "them" : "it"} only if you trust where this kubeconfig came from. kubeloupe remembers your answer for
    this source.
  </p>
  <div class="buttons">
    <button type="button" class="btn primary" onclick={() => void answerPrompt(true)}>Allow and check</button>
    <!-- The safe answer has the focus, so Enter never allows by accident. -->
    <button type="button" class="btn" onclick={() => void answerPrompt(false)} use:focus>Don't run</button>
  </div>
</div>

<style>
  .prompt {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    padding: 10px 12px;
    margin-bottom: 12px;
    border: 1px solid var(--amber);
    border-radius: 6px;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  code {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--bg-hover);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* A very long command scrolls instead of pushing the buttons away. */
    max-height: 160px;
    overflow-y: auto;
  }
  .used,
  .note {
    font-size: 12px;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
</style>
