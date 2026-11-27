<script lang="ts">
  import { onMount } from "svelte";
  import { skillStateText } from "../askAi";
  import { askAi, loadAskAiSetup, removeAskAiSkill } from "../stores/askAi.svelte";
  import { settings, updateSettings } from "../stores/settings.svelte";

  /** Settings, AI (#376, #466): which CLI Ask AI starts, a command of the
   *  user's own, and the nauvi skill Ask AI writes for each CLI. nauvi only
   *  finds CLIs on PATH; it installs none. */
  const current = $derived(settings.current);
  const setup = $derived(askAi.setup);
  onMount(() => void loadAskAiSetup());

  /** Why the last removal failed, by place. */
  let removeError = $state<Record<string, string>>({});

  async function remove(id: string) {
    removeError = { ...removeError, [id]: "" };
    try {
      await removeAskAiSkill(id);
    } catch (e) {
      removeError = { ...removeError, [id]: String(e) };
    }
  }

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
        ? "The nauvi CLI is on PATH, so the skill can use it."
        : "The nauvi CLI is not on PATH, so the skill can use kubectl only."}
    </p>
    {#if setup.skills.length > 0}
      <div class="skills" data-testid="ask-ai-skills">
        <span class="sub">nauvi skill</span>
        {#each setup.skills as s (s.id)}
          <div class="skill" data-testid="ask-ai-skill-{s.id}" data-state={s.state}>
            <div class="what">
              <span class="name">{s.label}</span>
              <code class="path" title={s.path}>{s.path}</code>
              <span class="state" class:installed={s.state === "current" || s.state === "outdated"}
                >{skillStateText(s)}</span
              >
              {#if removeError[s.id]}<span class="hint error">{removeError[s.id]}</span>{/if}
            </div>
            {#if s.state === "current" || s.state === "outdated"}
              <button
                type="button"
                class="btn small"
                aria-label="Remove the nauvi skill for {s.label}"
                onclick={() => void remove(s.id)}>Remove</button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/if}
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
  <label class="choice">
    <input
      type="checkbox"
      data-testid="ask-ai-open-views"
      checked={current.ask_ai_open_views ?? false}
      onchange={(e) => updateSettings({ ask_ai_open_views: e.currentTarget.checked })}
    />
    Let Ask AI open views
  </label>
  <p class="muted hint">
    The AI can then run <code>nauvi show</code> to open an object's panel or a table in the window of its Ask AI terminal,
    at most one every 3 seconds. It only opens views: no action, no dialog, and Back returns to where you were. It works
    in Ask AI sessions started after you turn it on. Links the AI prints (<code>nauvi://</code>) open with a click either
    way.
  </p>
  <p class="muted hint">
    A program on PATH or a full path, then its arguments. It runs as it is, never through a shell. It gets the prompt,
    after the nauvi guidance, in the file named by <code>NAUVI_PROMPT_FILE</code>. Ask AI writes the nauvi skill
    (<code>SKILL.md</code>, kubectl and the nauvi CLI) for the CLI it starts and updates it when nauvi changes; it sets
    up no MCP server and changes no other setting of your CLIs. The skill is not read-only: what the CLI runs in its
    shell is approved by the CLI's own prompts, not by nauvi. Like a local terminal, Ask AI opens nothing on a
    read-only context, and its terminals close when a context turns read-only.
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
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
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
  .skills {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sub {
    font-size: 13px;
  }
  .skill {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    min-width: 0;
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 12px;
  }
  .name {
    font-weight: 600;
  }
  .path {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    color: var(--text-muted);
  }
  .state.installed {
    color: var(--green);
  }
  .btn.small {
    padding: 2px 8px;
    flex-shrink: 0;
  }
</style>
