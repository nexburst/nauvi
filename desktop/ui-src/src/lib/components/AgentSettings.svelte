<script lang="ts">
  import { AGENT_GUIDE, mcpEntries } from "../agent";
  import { currentContextName } from "../stores/app.svelte";
  import { contextLabel } from "../stores/catalog.svelte";

  // For the cluster this window shows: the agent then does not follow
  // kubectl's current context somewhere else.
  const context = $derived(currentContextName());
  const entries = $derived(mcpEntries(context));
  /** Which entry was just copied (its client), for the button's answer. */
  let copied = $state("");
  let failed = $state("");

  async function copy(client: string, text: string) {
    failed = "";
    try {
      await navigator.clipboard.writeText(text);
      copied = client;
      setTimeout(() => copied === client && (copied = ""), 2000);
    } catch {
      failed = client;
    }
  }
</script>

<!-- Your own agent, with your own subscription: nauvi holds no model and no
     key. It only shows how to give the agent `nauvi mcp`. -->
<fieldset data-testid="agent-settings">
  <legend>Agents</legend>
  <p class="hint">
    Use the coding agent you already have (Claude Code, Codex, Cursor, Gemini CLI…) with this cluster. nauvi has no
    model and stores no key: your agent signs in itself. Give it the <code>nauvi mcp</code> tools with one of these
    entries{context ? `, for ${contextLabel(context)}` : ""}.
  </p>
  {#each entries as e (e.client)}
    <div class="entry">
      <div class="head">
        <span class="client">{e.client}</span>
        <span class="where">{e.where}</span>
        <button type="button" class="btn" aria-label={`Copy the entry for ${e.client}`} onclick={() => copy(e.client, e.text)}
          >{copied === e.client ? "Copied" : "Copy"}</button
        >
      </div>
      <pre data-testid="mcp-entry">{e.text}</pre>
      {#if failed === e.client}<p class="error-text">Could not copy to the clipboard. Select the text above instead.</p>{/if}
    </div>
  {/each}
  <div class="entry">
    <div class="head">
      <span class="client">A guide for the agent</span>
      <span class="where">Paste it into AGENTS.md, CLAUDE.md or a skill</span>
      <button type="button" class="btn" aria-label="Copy the guide for the agent" onclick={() => copy("guide", AGENT_GUIDE)}
        >{copied === "guide" ? "Copied" : "Copy"}</button
      >
    </div>
    {#if failed === "guide"}<p class="error-text">Could not copy to the clipboard.</p>{/if}
  </div>
  <p class="hint">
    Read-only: the agent can list, describe and read logs and events; Secret values are never returned. Adding
    <code>--allow-writes</code> after <code>mcp</code> lets it scale, restart, delete and apply. A read-only or
    protected context refuses those either way. On any row, <kbd>A</kbd> copies a prompt about that object.
  </p>
</fieldset>

<style>
  /* As the other sections of the Settings page. */
  fieldset {
    border: none;
    padding: 0;
    margin: 16px 0 0;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .hint {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .entry {
    margin-bottom: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 4px;
  }
  .client {
    font-size: 13px;
    font-weight: 600;
  }
  .where {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--font-num);
    font-size: 11.5px;
    line-height: 1.5;
    overflow-x: auto;
    user-select: text;
  }
  code,
  kbd {
    font-family: var(--font-num);
    font-size: 11px;
  }
  kbd {
    padding: 0 4px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
  }
</style>
