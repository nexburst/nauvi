<script lang="ts">
  import type { WorkloadConfig } from "../bindings";
  import { configSourceText, configVerdict, splitChecks } from "../imageConfig";
  import { imageConfig, selectConfig } from "../stores/imageConfig.svelte";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";

  /** One workload's failed checks (#538), in order: the verdict, what to
   *  change (worst first, in the operator's words), the lower-severity
   *  checks (collapsed), and where the data comes from. */
  let { target }: { target: WorkloadConfig } = $props();

  const s = $derived(imageSecuritySettings());
  const v = $derived(configVerdict(target, s));
  const now = Math.floor(Date.now() / 1000);
  const src = $derived(configSourceText(target, now));
  const detail = $derived(imageConfig.detail);
  const split = $derived(detail ? splitChecks(detail.failed, s) : { counted: [], lower: [] });
</script>

<aside data-testid="config-findings">
  <div class="header">
    <span class="title"><span class="muted">{target.target.kind}</span> {target.target.name}</span>
    <button type="button" class="close" aria-label="Close details" title="Close (Esc)" onclick={() => selectConfig(null)}
      >✕</button
    >
  </div>
  <div class="body">
    <p class="verdict {v.tone}" data-testid="config-findings-verdict">{v.text}</p>

    {#if imageConfig.detailError}
      <p class="error-text" data-testid="config-findings-error">{imageConfig.detailError}</p>
    {:else if !detail}
      <p class="muted">Reading the report…</p>
    {:else}
      {#if split.counted.length > 0}
        <h3>What to change</h3>
        <ul class="checks" data-testid="config-findings-checks">
          {#each split.counted as c (c.id + c.container)}
            <li>
              <span class="check-title"
                ><span class="sev {c.severity}">{c.severity}</span> {c.title || c.id}{#if c.container}<span class="muted">
                    · container {c.container}</span
                  >{/if}</span
              >
              {#if c.remediation}<span class="remediation">{c.remediation}</span>{/if}
              {#each c.messages.slice(0, 3) as m (m)}
                <span class="muted small">{m}</span>
              {/each}
              {#if c.description}<span class="muted small">{c.description} ({c.id})</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if split.lower.length > 0}
        <details data-testid="config-findings-lower">
          <summary>Lower severity ({split.lower.length})</summary>
          <ul class="checks">
            {#each split.lower as c (c.id + c.container)}
              <li>
                <span class="check-title"><span class="sev {c.severity}">{c.severity}</span> {c.title || c.id}</span>
                {#if c.remediation}<span class="remediation">{c.remediation}</span>{/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}

    <dl>
      <dt>Source</dt>
      <dd data-testid="config-findings-source">
        {src.text}{#if src.stale}<span class="stale"> (more than 7 days old)</span>{/if}
      </dd>
      <dt>Namespace</dt>
      <dd>{target.target.namespace}</dd>
      {#if detail}
        <dt>Passes</dt>
        <dd>{detail.passed} {detail.passed === 1 ? "check" : "checks"}</dd>
      {/if}
      <dt>Report</dt>
      <dd class="mono">{target.report_namespace}/{target.report_name}</dd>
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
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .checks li {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .check-title {
    font-weight: 500;
  }
  .sev {
    display: inline-block;
    font-size: 11px;
    font-weight: 500;
    text-transform: capitalize;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .sev.critical {
    color: var(--red);
  }
  .sev.high {
    color: var(--amber);
  }
  .small {
    font-size: 12px;
    word-break: break-word;
  }
  details {
    margin: 12px 0 0;
  }
  summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  details .checks {
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
