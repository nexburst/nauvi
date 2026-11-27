<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import type { ImageVulns } from "../bindings";
  import { fixSentence, sourceText, splitGroups, verdict, workloadsText } from "../imageSecurity";
  import { imageSecurity, imageSecuritySettings, selectImage } from "../stores/imageSecurity.svelte";
  import { usesLocal } from "../imageScan";
  import ImageScanAction from "./ImageScanAction.svelte";

  /** The findings of one image (#534), in order: the verdict, what to do
   *  (the fixes by package), what has no fix yet (collapsed: nothing to do
   *  now), and where the data comes from and how old it is. */
  let { target }: { target: ImageVulns } = $props();

  const s = $derived(imageSecuritySettings());
  const detail = $derived(imageSecurity.detail);
  // Kubescape's summaries do not say which have a fix; the full report does.
  const v = $derived(verdict(detail?.image ?? target, s));
  const now = Math.floor(Date.now() / 1000);
  const src = $derived(sourceText(target, now));
  const groups = $derived(detail ? splitGroups(detail.fix_groups) : { fixable: [], noFix: [] });
  const noFixCount = $derived(groups.noFix.reduce((n, g) => n + g.ids.length, 0));
  const links = $derived(new Map((detail?.vulnerabilities ?? []).filter((x) => x.link).map((x) => [x.id, x.link])));
</script>

<aside data-testid="image-findings">
  <div class="header">
    <span class="title"><span class="muted">Image</span> {target.image}</span>
    <button type="button" class="close" aria-label="Close details" title="Close (Esc)" onclick={() => selectImage(null)}
      >✕</button
    >
  </div>
  <div class="body">
    <p class="verdict {v.tone}" data-testid="findings-verdict">{v.text}</p>

    {#if target.scanned}
      {#if imageSecurity.detailError}
        <p class="error-text" data-testid="findings-error">{imageSecurity.detailError}</p>
      {:else if !detail}
        <p class="muted">Reading the report…</p>
      {:else}
        {#if groups.fixable.length > 0}
          <h3>What to do</h3>
          <ul class="fixes" data-testid="findings-fixes">
            {#each groups.fixable as g (g.package + g.installed_version)}
              <li>
                <span>{fixSentence(g, detail.vulnerabilities)}</span>
                <span class="muted ids">
                  {g.package} {g.installed_version}:
                  {#each g.ids.slice(0, 6) as id, i (id)}
                    {#if i > 0}{", "}{/if}{#if links.get(id)}<button
                        type="button"
                        class="advisory"
                        title={`Open ${links.get(id)} in the browser`}
                        onclick={() => openUrl(links.get(id)!).catch(() => {})}>{id}</button
                      >{:else}{id}{/if}
                  {/each}{#if g.ids.length > 6}
                    +{g.ids.length - 6} more{/if}
                </span>
              </li>
            {/each}
          </ul>
          <p class="muted hint">This usually means a newer image tag or a rebuild of the image.</p>
        {/if}
        {#if groups.noFix.length > 0}
          <details data-testid="findings-nofix">
            <summary>No fix yet ({noFixCount}): nothing to do now</summary>
            <ul class="fixes">
              {#each groups.noFix as g (g.package + g.installed_version)}
                <li>
                  <span>{g.package} {g.installed_version}</span>
                  <span class="muted ids">{g.ids.slice(0, 6).join(", ")}{g.ids.length > 6 ? ` +${g.ids.length - 6} more` : ""}</span>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      {/if}
    {/if}
    {#if usesLocal(s.source) && (!target.scanned || target.source === "local_scanner")}
      <ImageScanAction {target} />
    {:else if !target.scanned}
      <p class="muted">
        {#if target.source === "kubescape"}
          Kubescape has not scanned this image yet. It scans new workloads within minutes; if it stays like this, check
          that its vulnerability scanning is on for this namespace.
        {:else}
          No VulnerabilityReport covers this image yet. The Trivy Operator scans new workloads within minutes; if it
          stays like this, check that the operator watches this namespace.
        {/if}
      </p>
    {/if}

    <dl>
      <dt>Source</dt>
      <dd data-testid="findings-source">
        {src.text}{#if src.stale}<span class="stale"> (more than 7 days old)</span>{/if}
      </dd>
      {#if target.digest}
        <dt>Digest</dt>
        <dd class="mono">{target.digest}</dd>
      {/if}
      <dt>Used by</dt>
      <dd>{workloadsText(target.workloads) || "No running pod"}</dd>
      {#if target.report_name}
        <dt>Report</dt>
        <dd class="mono">{target.report_namespace}/{target.report_name}</dd>
      {/if}
    </dl>
  </div>
</aside>

<style>
  aside {
    width: 420px;
    flex-shrink: 0;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 13px;
    word-break: break-all;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: none;
    font-size: 14px;
    cursor: pointer;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px;
    font-size: 13px;
  }
  .verdict {
    margin: 0 0 12px;
    font-weight: 500;
    padding-left: 10px;
    border-left: 3px solid var(--border-strong, var(--border));
  }
  .verdict.critical {
    border-left-color: var(--red);
  }
  .verdict.high {
    border-left-color: var(--amber);
  }
  h3 {
    margin: 12px 0 6px;
    font-size: var(--text-sm, 12px);
    font-weight: 600;
    color: var(--text-muted);
  }
  .fixes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .fixes li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ids {
    font-size: 12px;
    word-break: break-word;
  }
  .advisory {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .hint {
    font-size: 12px;
    margin: 8px 0 0;
  }
  details {
    margin: 12px 0 0;
  }
  summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  details .fixes {
    margin-top: 8px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 16px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  .mono {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }
  .stale {
    color: var(--amber);
  }
  .error-text {
    color: var(--red);
  }
</style>
