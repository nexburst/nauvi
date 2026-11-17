<script lang="ts">
  import type { ExecCommand } from "../../bindings";
  import { app } from "../../stores/app.svelte";
  import { answerPrompt } from "../../stores/catalog.svelte";

  /** Asks before an added kubeconfig's login commands run (#201): shows
   *  each command line exactly and the contexts that use it. `onanswer`:
   *  what the answer does (by default the catalog's prompt); `compact`:
   *  inside a node of the cluster tree (ADR 0007). */
  let {
    source,
    commands,
    onanswer = answerPrompt,
    compact = false,
  }: {
    source: string;
    commands: ExecCommand[];
    onanswer?: (allow: boolean) => Promise<void>;
    compact?: boolean;
  } = $props();

  const many = $derived(commands.length > 1);
  /** The local files the contexts of `c` send besides running it (#244). */
  function filesOf(c: ExecCommand): string[] {
    const files = app.contexts.filter((x) => c.contexts.includes(x.name)).flatMap((x) => x.local_files);
    return [...new Set(files)];
  }

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<div class="prompt" class:compact role="alertdialog" aria-label="Allow login command" data-testid="exec-prompt">
  <p>
    <strong>{source}</strong> logs in by running {many ? "these commands" : "this command"} on this computer, as you:
  </p>
  <ul>
    {#each commands as c (c.command)}
      <li>
        <code data-testid="exec-command">{c.command}</code>
        <span class="muted used">Used by {c.contexts.join(", ")}</span>
        {#if filesOf(c).length}
          <span class="used files" data-testid="exec-local-files">Also sends local files: {filesOf(c).join(", ")}</span>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="muted note">
    Allow {many ? "them" : "it"} only if you trust where this kubeconfig came from. nauvi remembers your answer for
    this source.
  </p>
  <div class="buttons">
    <button type="button" class="btn primary" onclick={() => void onanswer(true)}>{compact ? "Allow and connect" : "Allow and check"}</button>
    <!-- The safe answer has the focus, so Enter never allows by accident. -->
    <button type="button" class="btn" onclick={() => void onanswer(false)} use:focus>Don't run</button>
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
  .files {
    overflow-wrap: anywhere;
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
    flex-wrap: wrap;
    gap: 8px;
  }
  /* Inside a node of the sidebar's cluster tree. */
  .prompt.compact {
    margin: 4px 4px 8px 0;
    padding: 8px;
    font-size: 12px;
  }
</style>
