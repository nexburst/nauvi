<script lang="ts">
  import { askAiPrompt, scopeSubject, startBlocked, writesBlocked } from "../askAi";
  import { askAi, closeAskAi, startAskAi } from "../stores/askAi.svelte";
  import { contextMode } from "../stores/contextMode.svelte";
  import { openHelpItem } from "../stores/help.svelte";
  import { openSettings } from "../stores/keyboard.svelte";
  import ClusterLabel from "./ClusterLabel.svelte";

  /** Ask AI (#376): pick the CLI, edit the prompt, choose read-only (the
   *  default) or writes, then start it in a dock tab. nauvi installs
   *  nothing: without a CLI on PATH it says what to install. */
  const scope = $derived(askAi.scope);
  const setup = $derived(askAi.setup);
  const mode = $derived(scope ? contextMode(scope.context) : undefined);
  const blocked = $derived(scope ? startBlocked(mode, scope.context) : "");
  const mcp = $derived(!!setup?.nauvi);
  const noWrites = $derived(writesBlocked(mode, mcp));

  let cli = $state("");
  /** The user picked the CLI here: a newer setup does not change it. */
  let picked = $state(false);
  let prompt = $state("");
  let edited = $state(false);
  let allowWrites = $state(false);

  // The CLI and the prompt once the setup is known; the user's edits stay.
  $effect(() => {
    if (!setup || !scope) return;
    if (!picked || !setup.found.some((c) => c.id === cli)) cli = setup.chosen;
    if (!edited) prompt = askAiPrompt(scope, !!setup.nauvi);
  });
  $effect(() => {
    if (noWrites) allowWrites = false;
  });

  const chosen = $derived(setup?.found.find((c) => c.id === cli));
  const canStart = $derived(!!scope && !blocked && !!chosen && prompt.trim() !== "");

  function start() {
    if (!canStart) return;
    startAskAi(cli, prompt, allowWrites && !noWrites);
  }

  function onkeydown(e: KeyboardEvent) {
    if (!scope) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeAskAi();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      start();
    }
  }

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window {onkeydown} />

{#if scope}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeAskAi()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Ask AI" data-testid="ask-ai-dialog">
      <h2>
        <span class="title">Ask AI about {scopeSubject(scope)}</span>
        {#if scope.context}<ClusterLabel id={scope.context} />{/if}
      </h2>

      {#if blocked}
        <p class="warn" data-testid="ask-ai-blocked">{blocked}</p>
        <div class="buttons">
          <button type="button" class="btn" use:focus onclick={closeAskAi}>Close</button>
        </div>
      {:else if !setup}
        <p class="muted">Looking for AI CLIs on PATH…</p>
      {:else if setup.found.length === 0}
        <div data-testid="ask-ai-none">
          <p>
            No AI CLI was found on PATH. Ask AI starts one you already have, signed in with your own account; nauvi
            installs nothing.
          </p>
          <p class="muted">Install one of these, then open Ask AI again:</p>
          <ul class="install">
            {#each setup.missing as m (m.id)}
              <li><b>{m.label}</b> <code>{m.install}</code></li>
            {/each}
          </ul>
          {#if setup.custom_error}
            <p class="warn" data-testid="ask-ai-custom-error">{setup.custom_error}</p>
          {/if}
          <p class="muted">Or set your own command in Settings, AI.</p>
        </div>
        <div class="buttons">
          <button type="button" class="btn link" onclick={() => void openHelpItem("ai_assistants")}
            >AI assistants and nauvi mcp</button
          >
          <span class="grow"></span>
          <button
            type="button"
            class="btn"
            onclick={() => {
              closeAskAi();
              openSettings();
            }}>Settings…</button
          >
          <button type="button" class="btn primary" use:focus onclick={closeAskAi}>Close</button>
        </div>
      {:else}
        <label class="row">
          <span class="label">CLI</span>
          <select
            class="select"
            bind:value={cli}
            onchange={() => (picked = true)}
            aria-label="AI CLI"
            data-testid="ask-ai-cli"
          >
            {#each setup.found as c (c.id)}
              <option value={c.id} title={c.path}>{c.label}</option>
            {/each}
          </select>
          {#if chosen}<code class="path" title={chosen.path}>{chosen.path}</code>{/if}
        </label>
        <label class="stack">
          <span class="label">Prompt <span class="muted">(you can edit it; it is sent when the CLI starts)</span></span>
          <textarea
            class="input prompt"
            rows="6"
            aria-label="Prompt"
            data-testid="ask-ai-prompt"
            bind:value={prompt}
            oninput={() => (edited = true)}
            use:focus
          ></textarea>
        </label>
        {#if mcp}
          <p class="note" data-testid="ask-ai-mcp">
            It gets the nauvi MCP tools for <b>{scope.context}</b>, for this session only:
            <b>{allowWrites ? "they can change the cluster" : "read-only"}</b>. Your CLI's own settings are not changed.
          </p>
        {:else}
          <p class="warn" data-testid="ask-ai-no-nauvi">
            The nauvi CLI is not on PATH, so the assistant gets kubectl in its terminal but no nauvi tools.
            <button type="button" class="inline" onclick={() => void openHelpItem("ai_assistants")}
              >How to set up nauvi mcp</button
            >
          </p>
        {/if}
        <label class="check" class:off={!!noWrites} title={noWrites}>
          <input type="checkbox" bind:checked={allowWrites} disabled={!!noWrites} data-testid="ask-ai-writes" />
          Allow writes (scale, restart, delete, apply)
        </label>
        {#if noWrites}
          <p class="muted small" data-testid="ask-ai-writes-off">{noWrites}</p>
        {:else if allowWrites}
          <p class="danger" role="alert" data-testid="ask-ai-writes-warning">
            The assistant can change <b>{scope.context}</b> as you (RBAC still applies), without nauvi asking you
            first: <code>apply</code> can create workloads that read Secrets, and <code>delete</code> of a namespace deletes
            everything in it. Leave this off unless you will check each change it proposes.
          </p>
        {/if}
        <p class="muted small">
          Your CLI and its provider decide what leaves this machine, as in any terminal. When the CLI exits, the tab is
          your shell.
        </p>
        <div class="buttons">
          <button type="button" class="btn" onclick={closeAskAi}>Cancel</button>
          <button
            type="button"
            class="btn primary"
            disabled={!canStart}
            data-testid="ask-ai-start"
            title="Start (Ctrl+Enter)"
            onclick={start}>Start {chosen?.label ?? ""}</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 110;
  }
  .dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    font-size: 15px;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.45;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    min-width: 0;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .label {
    font-size: 12px;
    color: var(--text-muted);
  }
  .row .label {
    width: 32px;
  }
  .path {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .prompt {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.4;
  }
  .note {
    color: var(--text-muted);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .check.off {
    color: var(--text-muted);
  }
  .warn {
    padding: 6px 8px;
    border: 1px solid var(--amber);
    border-radius: 6px;
  }
  .danger {
    padding: 6px 8px;
    border: 1px solid var(--red);
    border-radius: 6px;
    color: var(--text);
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 12px;
  }
  .install {
    margin: 0 0 8px;
    padding-left: 18px;
    font-size: 13px;
    line-height: 1.7;
  }
  code {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }
  .inline {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .btn.link {
    border-color: transparent;
    color: var(--accent);
  }
  .grow {
    flex: 1;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
</style>
