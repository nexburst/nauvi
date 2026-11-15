<script lang="ts">
  import { onMount, untrack } from "svelte";
  import CodeEditor from "../editor/CodeEditor.svelte";
  import { commands } from "../../bindings";
  import type { HelmChartDetails, HelmChartVersion } from "../../bindings";
  import { primaryNamespace } from "../../stores/app.svelte";
  import { helm } from "../../stores/helm.svelte";
  import { openDeploy, selectChart } from "../../stores/helmCharts.svelte";
  import { registerTabs } from "../../stores/keyboard.svelte";

  /** Detail panel of one chart: versions, README and default values. Remounted per chart. */
  let { chart }: { chart: string } = $props();

  const tabs = [
    { id: "readme", label: "README" },
    { id: "values", label: "Values" },
    { id: "versions", label: "Versions" },
  ];
  let tab = $state("readme");
  let versions = $state.raw<HelmChartVersion[]>([]);
  let versionsError = $state("");
  /** The version shown; empty until the versions are known (then the newest). */
  let version = $state("");
  let details = $state.raw<HelmChartDetails | null>(null);
  let detailsError = $state("");
  let seq = 0;

  onMount(() => {
    void (async () => {
      try {
        versions = await commands.cmdHelmChartVersions(chart);
        version = versions[0]?.version ?? "";
        versionsError = "";
      } catch (e) {
        versionsError = String(e);
      }
    })();
    return registerTabs({ count: () => tabs.length, select: (i) => (tab = tabs[i].id) });
  });

  async function loadDetails(v: string) {
    const n = ++seq;
    details = null;
    try {
      const d = await commands.cmdHelmChartShow(chart, v);
      if (n !== seq) return;
      details = d;
      detailsError = "";
    } catch (e) {
      if (n !== seq) return;
      detailsError = String(e);
    }
  }

  $effect(() => {
    const v = version;
    if (v || versionsError) untrack(() => void loadDetails(v));
  });

  function install() {
    openDeploy({ mode: "install", chart, version, namespace: primaryNamespace() || "default" });
  }
</script>

<aside data-testid="chart-detail">
  <div class="header">
    <span class="title"><span class="muted">Chart</span> {chart}</span>
    <button type="button" class="close" aria-label="Close details" onclick={() => selectChart(null)}>✕</button>
  </div>

  <div class="bar">
    <label class="rev">
      Version
      <select class="select" aria-label="Chart version" bind:value={version} disabled={versions.length === 0}>
        {#each versions as v (v.version)}
          <option value={v.version}>{v.version}{v.app_version ? ` (app ${v.app_version})` : ""}</option>
        {/each}
      </select>
    </label>
    <button
      type="button"
      class="btn primary"
      disabled={!!helm.helmMissing || !details}
      title={helm.helmMissing || "Install this chart version into the cluster"}
      onclick={install}>Install…</button
    >
  </div>
  {#if versionsError}<p class="error-text pad" role="alert">{versionsError}</p>{/if}

  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === t.id}
        class:active={tab === t.id}
        onclick={() => (tab = t.id)}>{t.label}</button
      >
    {/each}
  </div>

  {#if detailsError}
    <p class="error-text pad" role="alert">{detailsError}</p>
  {:else if !details}
    <p class="muted pad">Loading…</p>
  {:else if tab === "readme"}
    <div class="body">
      <dl>
        <dt>Version</dt>
        <dd data-testid="chart-version">{details.version}</dd>
        <dt>App version</dt>
        <dd>{details.app_version}</dd>
        <dt>Description</dt>
        <dd>{details.description}</dd>
        {#if details.home}
          <dt>Home</dt>
          <dd>{details.home}</dd>
        {/if}
      </dl>
      {#if details.readme.trim()}
        <pre class="readme" data-testid="chart-readme">{details.readme}</pre>
      {:else}
        <p class="muted small">The chart has no README.</p>
      {/if}
    </div>
  {:else if tab === "values"}
    {#if details.values.trim()}
      <div class="editor">
        <CodeEditor value={details.values} readonly label="Default values" testid="chart-values" />
      </div>
    {:else}
      <p class="muted pad">The chart has no default values.</p>
    {/if}
  {:else if tab === "versions"}
    <ul class="versions" data-testid="chart-versions">
      {#each versions as v (v.version)}
        <li>
          <button type="button" class="linkish" class:current={v.version === version} onclick={() => (version = v.version)}
            >{v.version}</button
          >
          <span class="muted">{v.app_version}</span>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  aside {
    width: 560px;
    flex-shrink: 0;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  aside > :global(*) {
    flex-shrink: 0;
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
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    font-size: 12px;
  }
  .rev {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 8px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .pad,
  .body {
    padding: 12px 16px;
    margin: 0;
  }
  .body {
    overflow-y: auto;
    flex: 1;
    flex-shrink: 1;
  }
  dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 4px 12px;
    margin: 0 0 12px;
    font-size: 13px;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  .readme {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    white-space: pre-wrap;
  }
  .small {
    font-size: 12px;
  }
  .editor {
    flex: 1;
    flex-shrink: 1;
    min-height: 0;
    overflow: auto;
  }
  .versions {
    list-style: none;
    margin: 0;
    padding: 12px 16px;
    font-size: 13px;
    overflow-y: auto;
  }
  .versions li {
    display: flex;
    gap: 12px;
    padding: 2px 0;
  }
  .linkish {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
  .linkish.current {
    font-weight: 600;
    color: var(--text);
  }
</style>
