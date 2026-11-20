<script lang="ts">
  import { onMount } from "svelte";
  import { askAi, loadAskAiSetup } from "../stores/askAi.svelte";
  import { settings, updateSettings } from "../stores/settings.svelte";

  /** Settings, AI (#376): which CLI Ask AI starts, and a command of the
   *  user's own. nauvi only finds CLIs on PATH; it installs nothing. */
  const current = $derived(settings.current);
  const setup = $derived(askAi.setup);
  onMount(() => void loadAskAiSetup());

  async function setCommand(value: string) {
    await updateSettings({ ask_ai_command: value });
    await loadAskAiSetup();
  }
</script>

<fieldset data-testid="ask-ai-settings">
  <legend>AI</legend>
  <label class="row">
    <span>Ask AI starts</span>
    <select
      class="select"
      aria-label="Ask AI CLI"
      value={current.ask_ai_cli || setup?.chosen || ""}
      onchange={(e) => updateSettings({ ask_ai_cli: e.currentTarget.value })}
    >
      {#each setup?.found ?? [] as c (c.id)}
        <option value={c.id}>{c.label}</option>
      {/each}
      {#if !setup?.found.some((c) => c.id === "custom")}
        <option value="custom" disabled={!current.ask_ai_command}>Custom command</option>
      {/if}
      {#if (setup?.found.length ?? 0) === 0}
        <option value="" disabled>None found on PATH</option>
      {/if}
    </select>
  </label>
  {#if setup}
    <p class="muted hint" data-testid="ask-ai-found">
      {#if setup.found.length > 0}
        Found on PATH: {setup.found
          .filter((c) => c.id !== "custom")
          .map((c) => c.label)
          .join(", ") || "none"}.
      {:else}
        No AI CLI found on PATH.
      {/if}
      {#if setup.missing.length > 0}
        Not found: {setup.missing.map((c) => c.label).join(", ")}.
      {/if}
      {setup.nauvi
        ? "The nauvi CLI is on PATH, so the assistant gets the nauvi tools."
        : "The nauvi CLI is not on PATH, so the assistant gets kubectl but no nauvi tools."}
    </p>
  {/if}
  <label class="row">
    <span>Custom command</span>
    <input
      class="input command"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label="Custom AI command"
      placeholder="my-agent --flag"
      value={current.ask_ai_command}
      onchange={(e) => void setCommand(e.currentTarget.value)}
    />
  </label>
  {#if setup?.custom_error}
    <p class="hint error" data-testid="ask-ai-command-error">{setup.custom_error}</p>
  {/if}
  <p class="muted hint">
    A program on PATH or a full path, then its arguments. It runs as it is, never through a shell. It gets the prompt
    in the file named by <code>NAUVI_PROMPT_FILE</code> and the nauvi MCP server (<code>mcpServers</code> JSON) in
    <code>NAUVI_MCP_CONFIG</code>. nauvi never changes your CLIs' own settings: the MCP server is given to each session
    only, read-only unless you allow writes when you start it.
  </p>
</fieldset>

<style>
  fieldset {
    border: none;
    padding: 0;
    margin: 16px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .hint.error {
    color: var(--red);
  }
  .muted {
    color: var(--text-muted);
  }
  .input.command {
    width: 260px;
  }
  code {
    font-size: 11.5px;
  }
</style>
