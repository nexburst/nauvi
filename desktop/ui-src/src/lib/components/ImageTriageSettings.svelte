<script lang="ts">
  import { onMount } from "svelte";
  import { agoText } from "../imageSecurity";
  import { expiryText, ignoreActive, kevStatusText, KEV_WORDS, scopeText } from "../imageTriage";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import {
    downloadKev,
    imageTriage,
    loadTriageStatus,
    removeIgnore,
    setIgnoreFile,
    setKevDownload,
  } from "../stores/imageTriage.svelte";

  /** Settings → Image security → Ignores and known exploited (#537, ADR
   *  0011): an ignore file, nauvi's own ignores, and the opt-in download
   *  of CISA's KEV catalogue (off by default). */
  const s = $derived(imageSecuritySettings());
  const status = $derived(imageTriage.status);
  // svelte-ignore state_referenced_locally
  let file = $state(s.ignore_file);
  const now = Math.floor(Date.now() / 1000);

  onMount(() => void loadTriageStatus());
</script>

<div class="triage" data-testid="image-triage-settings">
  <h4>Ignores</h4>
  <label class="row">
    <span>Ignore file</span>
    <input
      class="input"
      aria-label="Ignore file"
      placeholder="/path/to/.trivyignore"
      spellcheck="false"
      bind:value={file}
      onchange={() => setIgnoreFile(file)}
    />
  </label>
  <p class="muted hint">
    A .trivyignore: one vulnerability id per line, with exp:YYYY-MM-DD to end it and a # comment as its reason. Its
    ids are ignored in every image.
  </p>
  {#if s.ignore_file && status}
    {#if status.file_error}
      <p class="error-text hint" data-testid="ignore-file-error">{status.file_error}</p>
    {:else}
      <p class="muted hint" data-testid="ignore-file-status">
        {status.file_rules}
        {status.file_rules === 1 ? "ignore" : "ignores"} read.{#if status.file_skipped.length > 0}
          {" "}Not understood: {status.file_skipped.length === 1 ? "line" : "lines"}
          {status.file_skipped.join(", ")}.{/if}
      </p>
    {/if}
  {/if}

  {#if s.ignores.length === 0}
    <p class="muted hint" data-testid="ignores-empty">
      No ignores of your own. Add one from an image's findings: each needs a reason, and can end on a date.
    </p>
  {:else}
    <ul class="ignores" data-testid="ignores">
      {#each s.ignores as r (r.id + r.scope + r.image + r.namespace + r.kind + r.name + r.context)}
        {@const active = ignoreActive(r, now)}
        <li data-testid="ignore-rule" class:expired={!active}>
          <div class="what">
            <span class="mono">{r.id}</span>
            <span class="muted">in {scopeText(r)}{r.expires ? `, ${expiryText(r.expires, now)}` : ""}</span>
            <span class="reason">{r.reason}</span>
          </div>
          <button type="button" class="link" aria-label={`Stop ignoring ${r.id}`} onclick={() => removeIgnore(r)}
            >Remove</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  <h4>{KEV_WORDS}</h4>
  <label class="choice">
    <input
      type="checkbox"
      aria-label="Download the list of known exploited vulnerabilities"
      checked={s.kev_download}
      onchange={(e) => setKevDownload(e.currentTarget.checked)}
    />
    Download CISA's list of known exploited vulnerabilities
  </label>
  <p class="muted hint">
    Off unless you turn it on. nauvi then downloads one file, {status?.kev_url ?? "from www.cisa.gov"}, over https,
    and again once a day while image security is shown. Nothing about your clusters or images is sent. Findings on the
    list are marked "{KEV_WORDS.toLowerCase()}" and shown in red. Grype marks them itself, without this.
  </p>
  {#if s.kev_download}
    <div class="row">
      <span class="muted hint" data-testid="kev-status">
        {#if imageTriage.downloading}
          Downloading…
        {:else if status?.kev_kept}
          {kevStatusText(status.kev_version, status.kev_count, agoText(now - status.kev_fetched_at))}
        {:else}
          Not downloaded yet.
        {/if}
      </span>
      <button type="button" class="btn" disabled={imageTriage.downloading} onclick={() => downloadKev()}
        >Download now</button
      >
    </div>
    {#if imageTriage.error}
      <p class="error-text hint" data-testid="kev-error">{imageTriage.error}</p>
    {/if}
  {/if}
</div>

<style>
  .triage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }
  h4 {
    margin: 8px 0 0;
    font-size: 12px;
    font-weight: 600;
  }
  .row,
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .row {
    justify-content: space-between;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--text-muted);
  }
  .error-text {
    color: var(--red);
  }
  .input {
    width: 260px;
  }
  .ignores {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ignores li {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .ignores li.expired {
    opacity: 0.6;
  }
  .what {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 8px;
    min-width: 0;
  }
  .reason {
    flex-basis: 100%;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    flex-shrink: 0;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
