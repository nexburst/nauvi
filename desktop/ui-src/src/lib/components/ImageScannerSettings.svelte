<script lang="ts">
  import { onMount } from "svelte";
  import type { ImageSecuritySettings_Serialize as ImageSecuritySettings, ScannerKind, VulnSource } from "../bindings";
  import { SCANNERS, SOURCES, scannerLabel, scannerStateText, usesLocal } from "../imageScan";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { approveScanner, forgetScanner, imageScan, loadScannerStatus } from "../stores/imageScan.svelte";
  import { resetFindings } from "../stores/imageFindings.svelte";
  import { updateSettings } from "../stores/settings.svelte";

  /** Settings → Image security → Source (#536, ADR 0011): the Trivy
   *  Operator's reports, a Trivy or Grype on this computer, or both. The
   *  scanner is the user's own: nauvi finds it, runs it only once its file
   *  is approved, and never downloads a scanner or a database. */
  const s = $derived(imageSecuritySettings());
  const local = $derived(usesLocal(s.source));
  const status = $derived(imageScan.status);
  // svelte-ignore state_referenced_locally
  let dbRepository = $state(s.db_repository);
  // svelte-ignore state_referenced_locally
  let serverUrl = $state(s.server_url);

  async function save(change: Partial<ImageSecuritySettings>) {
    await updateSettings({ image_security: { ...imageSecuritySettings(), ...change } });
  }

  onMount(() => {
    if (local) void loadScannerStatus();
  });

  async function setSource(source: VulnSource) {
    await save({ source });
    // The surfaces read the listing again, from the new source.
    resetFindings();
    if (usesLocal(source)) void loadScannerStatus();
  }

  /** Whether the full SHA-256 was just copied ("" / "copied" / "failed"). */
  let copied = $state("");

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      copied = "copied";
    } catch {
      copied = "failed";
    }
    setTimeout(() => (copied = ""), 2000);
  }

  async function setScanner(scanner: ScannerKind) {
    await save({ scanner });
    resetFindings();
    void loadScannerStatus(scanner);
  }
</script>

<div class="scanner" data-testid="image-scanner-settings">
  <label class="row">
    <span>Source</span>
    <select
      class="select"
      aria-label="Where vulnerabilities come from"
      value={s.source}
      onchange={(e) => setSource(e.currentTarget.value as VulnSource)}
    >
      {#each SOURCES as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  </label>
  {#if local}
    <label class="row">
      <span>Scanner</span>
      <select
        class="select"
        aria-label="Scanner on this computer"
        value={s.scanner}
        onchange={(e) => setScanner(e.currentTarget.value as ScannerKind)}
      >
        {#each SCANNERS as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    </label>
    <div class="status" data-testid="image-scanner-status" data-state={status?.state ?? ""}>
      {#if imageScan.statusError}
        <p class="error-text" data-testid="image-scanner-error">{imageScan.statusError}</p>
        <div class="actions">
          <button type="button" class="btn" onclick={() => loadScannerStatus()}>Check again</button>
        </div>
      {:else if !status}
        <p class="muted">Looking for {scannerLabel(s.scanner)}…</p>
      {:else}
        <p class:error-text={status.state === "refused" || status.state === "broken"} class:muted={status.state !== "refused" && status.state !== "broken"}>
          {scannerStateText(status)}
        </p>
        {#if status.file && status.state !== "not_installed"}
          <p class="muted file" data-testid="image-scanner-file">
            <span title={status.sha256 ? `SHA-256 ${status.sha256}` : undefined}>{status.file}</span>
            {#if status.sha256}
              <button
                type="button"
                class="link"
                data-testid="image-scanner-copy-hash"
                aria-label="Copy the full SHA-256"
                onclick={() => copyHash(status.sha256)}
                >{copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy SHA-256"}</button
              >
            {/if}
          </p>
        {/if}
        {#if status.state === "unapproved" || status.state === "changed"}
          <div class="actions">
            <button
              type="button"
              class="btn primary"
              data-testid="image-scanner-approve"
              disabled={imageScan.statusLoading}
              onclick={approveScanner}>Approve {status.path}</button
            >
          </div>
        {:else if status.state === "ready"}
          <div class="actions">
            <button type="button" class="btn" data-testid="image-scanner-forget" onclick={forgetScanner}>Forget approval</button>
            <button type="button" class="btn" onclick={() => loadScannerStatus()}>Check again</button>
          </div>
        {:else}
          <div class="actions">
            <button type="button" class="btn" onclick={() => loadScannerStatus()}>Check again</button>
          </div>
        {/if}
      {/if}
    </div>
    {#if s.scanner === "trivy"}
      <label class="row">
        <span>Database repository</span>
        <input
          class="input"
          aria-label="Trivy database repository"
          placeholder="Trivy's default"
          spellcheck="false"
          bind:value={dbRepository}
          onchange={() => save({ db_repository: dbRepository.trim() })}
        />
      </label>
      <label class="row">
        <span>Trivy server</span>
        <input
          class="input"
          aria-label="Trivy server URL"
          placeholder="none: scan on this computer"
          spellcheck="false"
          bind:value={serverUrl}
          onchange={() => save({ server_url: serverUrl.trim() })}
        />
      </label>
    {/if}
    <label class="choice">
      <input
        type="checkbox"
        aria-label="Do not update the scanner's database"
        checked={s.skip_db_update}
        onchange={(e) => save({ skip_db_update: e.currentTarget.checked })}
      />
      Do not let the scanner update its database
    </label>
    <p class="muted hint">
      nauvi never downloads a scanner or a vulnerability database. The scanner runs on this computer, pulls each image
      by digest from its registry with your own docker login, and may update its own database unless you turn that off.
      A scan starts only when you click Scan.
    </p>
  {/if}
</div>

<style>
  .scanner {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .status p {
    margin: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .actions .btn {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file {
    font-family: var(--font-mono, monospace);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: baseline;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-sans, inherit);
  }
  .link:hover {
    text-decoration: underline;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .muted {
    color: var(--text-muted);
  }
  .input {
    width: 260px;
  }
</style>
