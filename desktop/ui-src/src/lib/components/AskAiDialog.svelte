<script lang="ts">
  import { askAiPrompt, dialogSubject, skillNote, skillOf, startBlocked } from "../askAi";
  import { askAi, closeAskAi, startAskAi } from "../stores/askAi.svelte";
  import { contextMode } from "../stores/contextMode.svelte";
  import { openHelpItem } from "../stores/help.svelte";
  import { openSettings } from "../stores/keyboard.svelte";
  import ClusterLabel from "./ClusterLabel.svelte";

  /** Ask AI (#376, #466): pick the CLI, edit the prompt, then start it in a
   *  dock tab with the nauvi skill (installed or updated on start; a custom
   *  command gets the guidance in its prompt). nauvi installs no CLI:
   *  without one on PATH it says what to install. */
  const scope = $derived(askAi.scope);
  const setup = $derived(askAi.setup);
  const mode = $derived(scope ? contextMode(scope.context) : undefined);
  const blocked = $derived(scope ? startBlocked(mode, scope.context) : "");

  let cli = $state("");
  /** The user picked the CLI here: a newer setup does not change it. */
  let picked = $state(false);
  let prompt = $state("");
  let edited = $state(false);

  // The CLI and the prompt once the setup is known; the user's edits stay.
  $effect(() => {
    if (!setup || !scope) return;
    if (!picked || !setup.found.some((c) => c.id === cli)) cli = setup.chosen;
    if (!edited) prompt = askAiPrompt(scope, !!setup.nauvi);
  });

  const chosen = $derived(setup?.found.find((c) => c.id === cli));
  const note = $derived(skillNote(chosen, skillOf(setup, chosen)));
  const canStart = $derived(!!scope && !blocked && !!chosen && prompt.trim() !== "");

  function start() {
    if (!canStart) return;
    startAskAi(cli, prompt);
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

  /** The prompt shows at least 8 lines, and grows with its text up to 12
   *  (#607); past that it scrolls. */
  const PROMPT_ROWS = 8;
  const PROMPT_MAX_ROWS = 12;
  function grow(node: HTMLTextAreaElement, _text: string) {
    const fit = () => {
      const style = getComputedStyle(node);
      const line = parseFloat(style.lineHeight) || 18;
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      node.style.height = "auto";
      const min = PROMPT_ROWS * line + pad + border;
      const max = PROMPT_MAX_ROWS * line + pad + border;
      node.style.height = `${Math.min(max, Math.max(min, node.scrollHeight + border))}px`;
    };
    fit();
    return { update: fit };
  }
</script>

<svelte:window {onkeydown} />

{#if scope}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeAskAi()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Ask AI" data-testid="ask-ai-dialog">
      <h2 class="title">Ask AI about {dialogSubject(scope)}</h2>
      {#if scope.context}<p class="on muted">on <ClusterLabel id={scope.context} /></p>{/if}

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
            >AI assistants and nauvi</button
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
            rows={PROMPT_ROWS}
            aria-label="Prompt"
            data-testid="ask-ai-prompt"
            bind:value={prompt}
            oninput={() => (edited = true)}
            use:focus
            use:grow={prompt}
          ></textarea>
        </label>
        {#if note.text}
          <p class:note={!note.warn} class:warn={note.warn} data-testid="ask-ai-skill">{note.text}</p>
        {/if}
        {#if !setup.nauvi}
          <p class="warn" data-testid="ask-ai-no-nauvi">
            The nauvi CLI is not on PATH, so the assistant can use kubectl but not <code>nauvi problems</code>,
            <code>nauvi logs</code> or <code>nauvi yaml</code>.
            <button type="button" class="inline" onclick={() => void openHelpItem("ai_assistants")}
              >How to install the nauvi CLI</button
            >
          </p>
        {/if}
        <!-- One line; the rest one click away (#607). -->
        <details class="caveats" data-testid="ask-ai-shell-note">
          <summary
            ><span data-testid="ask-ai-caveat"
              >Runs {chosen?.label ?? "your CLI"} in a local terminal with this cluster's kubeconfig; your CLI asks before
              it runs commands.</span
            > <span class="details">Details</span></summary
          >
          <p>
            The CLI gets a shell with this cluster's kubeconfig, and no MCP server. What it runs there (<code
              >kubectl</code
            >, <code>nauvi</code>, <code>helm</code>…) is allowed or refused by your CLI's own approval prompts, not by
            nauvi, as in a local terminal: the skill is not read-only.
          </p>
          <p>
            Your CLI and its provider decide what leaves this machine, as in any terminal. When the CLI exits, the tab is
            your shell.
          </p>
        </details>
        <div class="buttons">
          <button type="button" class="btn" onclick={closeAskAi}>Cancel</button>
          <button
            type="button"
            class="btn start"
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
    width: min(600px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
  }
  h2 {
    margin: 0 0 2px;
    font-size: 15px;
    min-width: 0;
  }
  .on {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 12px;
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
  /* What the CLI can do, in one line; the rest under Details. */
  .caveats {
    margin: 0 0 8px;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--text-muted);
  }
  .caveats summary {
    cursor: pointer;
    list-style: none;
  }
  .caveats summary::-webkit-details-marker {
    display: none;
  }
  .caveats .details {
    color: var(--accent);
    text-decoration: underline;
    white-space: nowrap;
  }
  .caveats[open] .details {
    display: none;
  }
  .caveats p {
    margin: 6px 0 0;
    font-size: var(--text-sm);
  }
  /* The one filled button: Start. */
  .btn.start {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: var(--weight-semibold);
  }
  .btn.start:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, var(--text));
    color: var(--on-accent);
  }
  .btn.start:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .warn {
    padding: 6px 8px;
    border: 1px solid var(--amber);
    border-radius: 6px;
  }
  .muted {
    color: var(--text-muted);
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
