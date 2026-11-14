<script lang="ts">
  import { checkSummary, progressLabel, progressPercent, showsBanner } from "../updates";
  import {
    dismissAnnouncement,
    dismissUpdate,
    installUpdate,
    openReleasePage,
    updates,
  } from "../stores/updates.svelte";

  /** A newer release (#30): one line above the content, closable, and the
   *  install only starts from the button. */
  const check = $derived(updates.check);
  const offered = $derived(showsBanner(check, updates.dismissed));
  const percent = $derived(updates.progress ? progressPercent(updates.progress) : null);
</script>

{#if offered && check}
  <div class="update" role="status" data-testid="update-banner">
    <span class="text">
      kubeloupe {check.version} is available —
      <button type="button" class="link" onclick={openReleasePage}>Release notes</button>
      ·
      {#if check.can_install}
        <button type="button" class="link" disabled={updates.installing} onclick={installUpdate}
          >Install and restart</button
        >
      {:else}
        <button type="button" class="link" onclick={openReleasePage}>Download from the release page</button>
      {/if}
    </span>
    {#if updates.installing && updates.progress}
      <span class="progress" data-testid="update-progress">
        <span
          class="bar"
          role="progressbar"
          aria-label="Update download"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={percent ?? undefined}
        >
          <span class="fill" class:unknown={percent === null} style:width={percent === null ? "30%" : `${percent}%`}
          ></span>
        </span>
        <span class="muted">{progressLabel(updates.progress)}</span>
      </span>
    {:else if updates.installError}
      <span class="error" role="alert">{updates.installError}</span>
    {:else if !check.can_install && check.note}
      <span class="muted note">{check.note}</span>
    {/if}
    {#if !updates.installing}
      <button type="button" class="x" aria-label="Dismiss update" onclick={dismissUpdate}>✕</button>
    {/if}
  </div>
{:else if updates.announce && !updates.checking && (check || updates.checkError)}
  <div class="update" class:fail={!!updates.checkError} role="status" data-testid="update-notice">
    <span class="text">
      {updates.checkError ? updates.checkError : check ? checkSummary(check) : ""}
    </span>
    <button type="button" class="x" aria-label="Dismiss" onclick={dismissAnnouncement}>✕</button>
  </div>
{/if}

<style>
  .update {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin: 12px 16px 0;
    padding: 6px 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }
  .update.fail {
    border-color: var(--red);
    color: var(--error-text);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
  .link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .link:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .bar {
    display: inline-block;
    width: 140px;
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.15s linear;
  }
  .fill.unknown {
    opacity: 0.6;
  }
  .note,
  .error {
    font-size: 12px;
  }
  .error {
    color: var(--error-text);
  }
  .x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
  }
</style>
