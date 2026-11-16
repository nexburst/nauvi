<script lang="ts">
  import { onMount } from "svelte";
  import { copyDiagnostics, help, loadDiagnostics, openHelpItem } from "../stores/help.svelte";

  /** Settings → About (#208): the version and commit, the OS and webview,
   *  and "Copy diagnostics" for a bug report. */
  let section = $state<HTMLFieldSetElement | null>(null);
  let copied = $state<{ ok: boolean; text: string } | null>(null);
  const d = $derived(help.diagnostics);

  onMount(() => {
    void loadDiagnostics();
    if (help.showAbout) {
      help.showAbout = false;
      section?.scrollIntoView({ block: "start" });
    }
  });

  async function copy() {
    copied = await copyDiagnostics();
  }
</script>

<fieldset bind:this={section} data-testid="about-settings">
  <legend>About</legend>
  {#if d}
    <div class="row">
      <span data-testid="about-version"
        >kubeloupe {d.version}{d.debug_build ? " (debug build)" : ""}
        <span class="muted">· commit <code>{d.commit}</code></span></span
      >
    </div>
    <pre class="facts" data-testid="diagnostics-text">{d.text}</pre>
  {:else if help.error}
    <p class="hint error">{help.error}</p>
  {:else}
    <p class="muted hint">Loading…</p>
  {/if}
  <div class="row">
    <span class="muted status" data-testid="diagnostics-copied" class:error={copied && !copied.ok}>{copied?.text ?? ""}</span>
    <span class="buttons">
      <button type="button" class="btn" onclick={() => openHelpItem("log_folder")}>Open log folder</button>
      <button type="button" class="btn" disabled={!d} onclick={copy}>Copy diagnostics</button>
    </span>
  </div>
  <p class="muted hint">
    The diagnostics are the version, commit, OS and webview, nothing about your clusters. Help → Report a bug opens a
    GitHub issue with them filled in.
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
  .buttons {
    display: flex;
    gap: 6px;
  }
  .facts {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .status {
    font-size: 12px;
  }
  .error {
    color: var(--red);
  }
</style>
