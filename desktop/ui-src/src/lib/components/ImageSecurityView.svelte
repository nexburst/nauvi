<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { app, currentContextName, setNamespaces, stamp } from "../stores/app.svelte";
  import { openSettings } from "../stores/keyboard.svelte";
  import {
    imageSecurity,
    imageSecurityEnabled,
    imageSecuritySettings,
    loadImageSecurity,
    resetImageSecurity,
    selectImage,
    setClusterImageSecurity,
  } from "../stores/imageSecurity.svelte";
  import { agoText, headline, headlineDetail, imageRows, sourceText, stateMessage, viewNotes, workloadsText } from "../imageSecurity";
  import { rowHeightPx } from "../preferences";
  import { settings } from "../stores/settings.svelte";
  import EmptyState from "./EmptyState.svelte";
  import ImageScanBar from "./ImageScanBar.svelte";
  import { usesLocal } from "../imageScan";
  import VirtualList from "./VirtualList.svelte";

  /** Image security (#534, ADR 0011): one row per running image of the
   *  namespaces shown, with what the Trivy Operator's reports say. Off
   *  until the user turns it on; read when the view opens, on Refresh and
   *  when the namespaces change, never in the background. */

  const context = $derived(currentContextName());
  const enabled = $derived(imageSecurityEnabled(context));
  const s = $derived(imageSecuritySettings());
  const ROW_HEIGHT = $derived(rowHeightPx(52, settings.current.row_height));

  let now = $state(Math.floor(Date.now() / 1000));
  const tick = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);

  // Read on open, again for each namespace change; Refresh reads the
  // reports again instead of taking the cache.
  let lastNonce = -1;
  $effect(() => {
    if (!enabled) return;
    const nonce = app.refreshNonce;
    const namespaces = [...app.selectedNamespaces];
    untrack(() => {
      const refresh = lastNonce !== -1 && nonce !== lastNonce;
      lastNonce = nonce;
      void loadImageSecurity(namespaces, refresh).then(stamp);
    });
  });

  onDestroy(() => {
    clearInterval(tick);
    resetImageSecurity();
  });

  const summary = $derived(imageSecurity.list?.summary ?? null);
  const empty = $derived(summary ? stateMessage(summary) : null);
  const rows = $derived(summary ? imageRows(summary.images, s, app.search) : []);
  const allRows = $derived(summary ? imageRows(summary.images, s) : []);
  const notes = $derived(summary ? viewNotes(summary) : []);
  const getKey = $derived((i: number) => rows[i]?.key ?? i);

  $effect(() => {
    app.count = summary && !empty ? `${rows.length} of ${allRows.length} images` : "";
  });

  function again() {
    void loadImageSecurity([...app.selectedNamespaces], true);
  }
</script>

<div class="view" data-testid="image-security">
  {#if !enabled}
    <div class="center">
      <EmptyState
        title="Image security is off for this cluster"
        detail="When it is on, nauvi reads the Trivy Operator's VulnerabilityReports for the namespaces you pick when this view, the Overview, a pod or workload panel or the Vulns column is shown. nauvi scans nothing and downloads nothing itself."
        reason="off"
      >
        <button
          type="button"
          class="btn primary"
          data-testid="image-security-turn-on"
          onclick={() => setClusterImageSecurity(context, "on")}>Turn on for this cluster</button
        >
        <button type="button" class="btn" onclick={openSettings}>Settings…</button>
      </EmptyState>
    </div>
  {:else if imageSecurity.error}
    <div class="center">
      <EmptyState title="Could not read the image scans" detail={imageSecurity.error} reason="error">
        <button type="button" class="btn primary" onclick={again}>Try again</button>
      </EmptyState>
    </div>
  {:else if !summary}
    <p class="muted loading">{s.source === "local" ? "Reading the pods' images…" : "Reading the Trivy Operator's reports…"}</p>
  {:else if empty}
    <div class="center" data-testid="image-security-state" data-state={summary.state}>
      <EmptyState title={empty.title} detail={empty.detail} reason={empty.reason}>
        {#if summary.state === "forbidden" && app.selectedNamespaces.length > 0 && summary.all_namespaces_allowed}
          <button type="button" class="btn" onclick={() => setNamespaces([])}>All namespaces</button>
        {/if}
        {#if summary.state === "no_reports" && summary.unscanned > 0}
          <span class="muted">{summary.unscanned} running {summary.unscanned === 1 ? "image" : "images"} not scanned yet.</span>
        {/if}
      </EmptyState>
    </div>
  {:else}
    <div class="summary" data-testid="image-security-summary">
      <div class="headline">
        <span class="big" data-testid="image-security-headline">{headline(allRows)}</span>
        <span class="muted">{headlineDetail(allRows, s)}</span>
      </div>
      <div class="read muted">
        Read {agoText(now - (imageSecurity.list?.read_at ?? now))}
        <button type="button" class="link" disabled={imageSecurity.loading} onclick={again}
          >{imageSecurity.loading ? "Reading…" : "Read again"}</button
        >
      </div>
    </div>
    {#if usesLocal(s.source)}
      <ImageScanBar images={allRows.map((r) => r.row)} />
    {/if}
    {#if notes.length > 0}
      <ul class="notes muted" data-testid="image-security-notes">
        {#each notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
    <div class="list" aria-label="Images">
      <VirtualList count={rows.length} rowHeight={ROW_HEIGHT} {getKey}>
        {#snippet row(i)}
          {@const r = rows[i]}
          {#if r}
            {@const src = sourceText(r.row, now)}
            <div
              class="item"
              role="button"
              tabindex="0"
              aria-label={`${r.row.image}: ${r.verdict.text}`}
              onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), selectImage(r.row))}
              data-testid="image-row"
              data-key={r.key}
              data-tone={r.verdict.tone}
              data-kind={r.verdict.kind}
              class:selected={r.key === imageSecurity.selected}
              onclick={() => selectImage(r.row)}
            >
              <div class="line">
                <span class="image" title={r.row.digest ? `${r.row.image}\n${r.row.digest}` : r.row.image}>{r.row.image}</span>
                <span class="workloads muted" title={workloadsText(r.workloads)}>{workloadsText(r.workloads)}</span>
              </div>
              <div class="line">
                <span class="verdict {r.verdict.tone}" data-testid="image-verdict">
                  <span class="dot" aria-hidden="true"></span>{r.verdict.text}
                </span>
                <span class="source muted" class:stale={src.stale}>
                  {src.text}{#if src.stale}{" · "}<span class="stale-tag" title="The report is more than 7 days old: the operator may have stopped scanning this image.">old scan</span>{/if}
                </span>
              </div>
            </div>
          {/if}
        {/snippet}
      </VirtualList>
      {#if rows.length === 0}
        <div class="center overlay" data-testid="image-security-empty">
          {#if app.search}
            <EmptyState title="No image matches the filter" detail={`Nothing in this list has "${app.search}".`} reason="filter">
              <button type="button" class="btn primary" onclick={() => (app.search = "")}>Clear filter</button>
            </EmptyState>
          {:else}
            <EmptyState
              title="No images here"
              detail="No pod in these namespaces runs an image, or every one is in a namespace Settings → Image security leaves out."
              reason="empty"
            />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 16px 16px;
    position: relative;
  }
  .center {
    display: flex;
    justify-content: center;
    padding-top: 48px;
  }
  .overlay {
    position: absolute;
    inset: 0;
  }
  .loading {
    padding: 24px 8px;
    margin: 0;
  }
  .summary {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 12px 0 8px;
    border-bottom: 1px solid var(--border);
  }
  .headline {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .big {
    font-size: var(--text-md, 15px);
    font-weight: 600;
    color: var(--text);
  }
  .read {
    font-size: 12px;
    white-space: nowrap;
  }
  .link {
    background: none;
    border: none;
    padding: 0 0 0 6px;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .link:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .notes {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 12px;
  }
  .list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
    margin-top: 4px;
  }
  .item {
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    min-width: 0;
  }
  .item:hover,
  .item.selected {
    background: var(--bg-hover);
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
  }
  .line > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .image {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    flex: 0 1 auto;
  }
  .workloads,
  .source {
    font-size: 12px;
    margin-left: auto;
    flex: 0 1 auto;
    text-align: right;
  }
  .verdict {
    font-size: 13px;
    flex: 1 1 auto;
    color: var(--text);
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
    background: var(--text-muted);
    opacity: 0.6;
  }
  .verdict.critical .dot {
    background: var(--red);
    opacity: 1;
  }
  .verdict.high .dot {
    background: var(--amber);
    opacity: 1;
  }
  .stale-tag {
    color: var(--amber);
  }
</style>
