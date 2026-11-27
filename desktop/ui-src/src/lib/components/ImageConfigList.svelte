<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { app, setNamespaces, stamp } from "../stores/app.svelte";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { imageConfig, loadImageConfig, resetImageConfig, selectConfig } from "../stores/imageConfig.svelte";
  import {
    configHeadline,
    configHeadlineDetail,
    configNotes,
    configRows,
    configSourceText,
    configStateMessage,
    targetText,
  } from "../imageConfig";
  import { agoText } from "../imageSecurity";
  import { rowHeightPx } from "../preferences";
  import { settings } from "../stores/settings.svelte";
  import EmptyState from "./EmptyState.svelte";
  import VirtualList from "./VirtualList.svelte";

  /** The Configuration tab of Image security (#538): one row per workload
   *  of the namespaces shown, with the checks the Trivy Operator's
   *  ConfigAuditReports say it fails. Read when the tab opens, on Refresh
   *  and when the namespaces change, never in the background. */

  const s = $derived(imageSecuritySettings());
  const ROW_HEIGHT = $derived(rowHeightPx(52, settings.current.row_height));

  let now = $state(Math.floor(Date.now() / 1000));
  const tick = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);

  let lastNonce = -1;
  $effect(() => {
    const nonce = app.refreshNonce;
    const namespaces = [...app.selectedNamespaces];
    untrack(() => {
      const refresh = lastNonce !== -1 && nonce !== lastNonce;
      lastNonce = nonce;
      void loadImageConfig(namespaces, refresh).then(stamp);
    });
  });

  onDestroy(() => {
    clearInterval(tick);
    resetImageConfig();
  });

  const summary = $derived(imageConfig.list?.summary ?? null);
  const empty = $derived(summary ? configStateMessage(summary) : null);
  const rows = $derived(summary ? configRows(summary.workloads, s, app.search) : []);
  const allRows = $derived(summary ? configRows(summary.workloads, s) : []);
  const notes = $derived(summary ? configNotes(summary) : []);
  const getKey = $derived((i: number) => rows[i]?.key ?? i);

  $effect(() => {
    app.count = summary && !empty ? `${rows.length} of ${allRows.length} workloads` : "";
  });

  function again() {
    void loadImageConfig([...app.selectedNamespaces], true);
  }
</script>

<div class="config" data-testid="image-config">
  {#if imageConfig.error}
    <div class="center">
      <EmptyState title="Could not read the configuration audits" detail={imageConfig.error} reason="error">
        <button type="button" class="btn primary" onclick={again}>Try again</button>
      </EmptyState>
    </div>
  {:else if !summary}
    <p class="muted loading">Reading the Trivy Operator's ConfigAuditReports…</p>
  {:else if empty}
    <div class="center" data-testid="image-config-state" data-state={summary.state}>
      <EmptyState title={empty.title} detail={empty.detail} reason={empty.reason}>
        {#if summary.state === "forbidden" && app.selectedNamespaces.length > 0 && summary.all_namespaces_allowed}
          <button type="button" class="btn" onclick={() => setNamespaces([])}>All namespaces</button>
        {/if}
      </EmptyState>
    </div>
  {:else}
    <div class="summary" data-testid="image-config-summary">
      <div class="headline">
        <span class="big" data-testid="image-config-headline">{configHeadline(allRows)}</span>
        <span class="muted">{configHeadlineDetail(allRows, s)}</span>
      </div>
      <div class="read muted">
        Read {agoText(now - (imageConfig.list?.read_at ?? now))}
        <button type="button" class="link" disabled={imageConfig.loading} onclick={again}
          >{imageConfig.loading ? "Reading…" : "Read again"}</button
        >
      </div>
    </div>
    {#if notes.length > 0}
      <ul class="notes muted" data-testid="image-config-notes">
        {#each notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
    <div class="list" aria-label="Workloads">
      <VirtualList count={rows.length} rowHeight={ROW_HEIGHT} {getKey}>
        {#snippet row(i)}
          {@const r = rows[i]}
          {#if r}
            {@const src = configSourceText(r.row, now)}
            <div
              class="item"
              role="button"
              tabindex="0"
              aria-label={`${targetText(r.row)} in ${r.row.target.namespace}: ${r.verdict.text}`}
              onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), selectConfig(r.row))}
              data-testid="config-row"
              data-key={r.key}
              data-tone={r.verdict.tone}
              data-kind={r.verdict.kind}
              class:selected={r.key === imageConfig.selected}
              onclick={() => selectConfig(r.row)}
            >
              <div class="line">
                <span class="name">{targetText(r.row)}</span>
                <span class="where muted">{r.row.target.namespace}</span>
              </div>
              <div class="line">
                <span class="verdict {r.verdict.tone}" data-testid="config-verdict">
                  <span class="dot" aria-hidden="true"></span>{r.verdict.text}
                </span>
                <span class="source muted">
                  {src.text}{#if src.stale}{" · "}<span
                      class="stale-tag"
                      title="The report is more than 7 days old: the operator may have stopped checking this workload."
                      >old check</span
                    >{/if}
                </span>
              </div>
            </div>
          {/if}
        {/snippet}
      </VirtualList>
      {#if rows.length === 0}
        <div class="center overlay" data-testid="image-config-empty">
          {#if app.search}
            <EmptyState title="No workload matches the filter" detail={`Nothing in this list has "${app.search}".`} reason="filter">
              <button type="button" class="btn primary" onclick={() => (app.search = "")}>Clear filter</button>
            </EmptyState>
          {:else}
            <EmptyState
              title="No workloads here"
              detail="Every report is in a namespace Settings → Image security leaves out."
              reason="empty"
            />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .config {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
  .name {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    flex: 0 1 auto;
  }
  .where,
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
