<script lang="ts">
  import { onMount, untrack } from "svelte";
  import CodeEditor from "../editor/CodeEditor.svelte";
  import DiffView from "../editor/DiffView.svelte";
  import { commands } from "../../bindings";
  import type { HelmChartVersion, HelmDeployRequest, HelmDeployResult } from "../../bindings";
  import { app, setView } from "../../stores/app.svelte";
  import { setNotice } from "../../stores/actions.svelte";
  import { helm, loadReleases, selectRelease } from "../../stores/helm.svelte";
  import { closeDeploy, runDeploy } from "../../stores/helmCharts.svelte";
  import type { DeployTarget } from "../../stores/helmCharts.svelte";
  import {
    chartSources,
    defaultReleaseName,
    namespaceError,
    nextValues,
    notInRepos,
    pickVersion,
    releaseNameError,
    sameDeploy,
  } from "../../helmCharts";
  import { HELM_VIEW } from "../../helm";

  /**
   * Install a chart, or upgrade a release, with edited values. A dry run
   * (`--dry-run=server`) comes first: the manifest for an install, a diff
   * against the current revision for an upgrade. Mounted while open.
   */
  let { target }: { target: DeployTarget } = $props();
  const mode = untrack(() => target.mode);
  const upgrade = untrack(() => (target.mode === "upgrade" ? target : null));

  let step = $state<"form" | "preview" | "done">("form");
  let sources = $state.raw(new Map<string, HelmChartVersion[]>());
  let sourcesError = $state("");
  let sourcesLoaded = $state(false);
  let source = $state(untrack(() => (target.mode === "install" ? target.chart : "")));
  let version = $state(untrack(() => target.version));
  let name = $state(untrack(() => (target.mode === "upgrade" ? target.name : defaultReleaseName(target.chart))));
  let namespace = $state(untrack(() => target.namespace));
  let createNamespace = $state(true);
  let reveal = $state(false);
  let values = $state(untrack(() => (target.mode === "upgrade" ? target.values : "")));
  /** The chart defaults the values were last filled from (install). */
  let defaults = $state("");
  let defaultsError = $state("");

  let busy = $state(false);
  let error = $state("");
  /** The dry run, and the request it ran. */
  let preview = $state.raw<HelmDeployResult | null>(null);
  let previewed = $state.raw<HelmDeployRequest | null>(null);
  /** The current revision's manifest (upgrade), redacted like the preview. */
  let currentManifest = $state("");
  let result = $state.raw<HelmDeployResult | null>(null);

  const versions = $derived(sources.get(source) ?? []);
  const nameProblem = $derived(releaseNameError(name));
  const nsProblem = $derived(namespaceError(namespace));
  const request = $derived<HelmDeployRequest>({
    name,
    namespace,
    chart: source,
    version,
    values,
    create_namespace: mode === "install" && createNamespace,
    dry_run: true,
    reveal,
  });
  const canPreview = $derived(
    !busy && !helm.helmMissing && !!source && !!version && !nameProblem && !nsProblem && !defaultsError,
  );
  const title = $derived(
    mode === "install" ? `Install ${untrack(() => target.chart)}` : `Upgrade ${namespace}/${name}`,
  );

  onMount(() => {
    void (async () => {
      try {
        const found = await commands.cmdHelmChartVersions(untrack(() => target.chart));
        sources = chartSources(found);
        if (upgrade) {
          // Prefer a repository that has the release's version.
          const keys = [...sources.keys()];
          source = keys.find((k) => sources.get(k)?.some((v) => v.version === upgrade.version)) ?? keys[0] ?? "";
          if (!source) sourcesError = notInRepos(upgrade.chart);
        } else if (!sources.has(source)) {
          sourcesError = `Chart ${source} is no longer in its repository: update the repositories and try again.`;
        }
        version = pickVersion(sources.get(source) ?? [], untrack(() => target.version));
      } catch (e) {
        sourcesError = String(e);
      } finally {
        sourcesLoaded = true;
      }
    })();
  });

  // The version list follows the chosen repository.
  function pickSource(s: string) {
    source = s;
    version = pickVersion(sources.get(s) ?? [], version);
  }

  // Install: start from the chart version's defaults, keeping edits.
  let defaultsSeq = 0;
  $effect(() => {
    const s = source;
    const v = version;
    if (mode !== "install" || !s || !v) return;
    const n = ++defaultsSeq;
    untrack(() => {
      defaultsError = "";
      void commands.cmdHelmChartShow(s, v).then(
        (d) => {
          if (n !== defaultsSeq) return;
          values = nextValues(values, defaults, d.values);
          defaults = d.values;
        },
        (e) => {
          if (n === defaultsSeq) defaultsError = String(e);
        },
      );
    });
  });

  async function runPreview() {
    if (!canPreview) return;
    busy = true;
    error = "";
    const req = { ...request };
    try {
      const [dry, current] = await Promise.all([
        runDeploy(mode, req),
        upgrade ? commands.cmdHelmGet(namespace, name, 0, reveal) : Promise.resolve(null),
      ]);
      preview = dry;
      previewed = req;
      currentManifest = current?.manifest ?? "";
      step = "preview";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    if (!previewed || busy || !sameDeploy(previewed, request)) return;
    busy = true;
    error = "";
    try {
      result = await runDeploy(mode, { ...previewed, dry_run: false });
      step = "done";
      setNotice(true, result.summary);
      helm.nonce += 1;
      void loadReleases(app.selectedNamespaces);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function back() {
    step = "form";
    error = "";
  }

  function openRelease() {
    if (!result) return;
    const sel = { namespace: result.namespace, name: result.name };
    closeDeploy();
    setView(HELM_VIEW);
    selectRelease(sel);
  }

  function close() {
    if (!busy) closeDeploy();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !e.defaultPrevented) close();
  }

  function focusFirst(node: HTMLElement) {
    node.querySelector<HTMLElement>("input, select")?.focus();
  }
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
  <div
    class="dialog"
    class:compact={step === "done"}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    data-testid="helm-deploy"
    use:focusFirst
  >
    <div class="head">
      <h2>{title}</h2>
      <span class="steps muted" data-testid="deploy-step">
        <span class:on={step === "form"}>1 Values</span> ›
        <span class:on={step === "preview"}>2 Dry run</span> ›
        <span class:on={step === "done"}>3 {mode === "install" ? "Installed" : "Upgraded"}</span>
      </span>
    </div>

    {#if step === "form"}
      <div class="fields">
        {#if mode === "install"}
          <label>
            Release name
            <input class="input mono" aria-label="Release name" spellcheck="false" bind:value={name} />
          </label>
          <label>
            Namespace
            <input class="input mono" aria-label="Namespace" spellcheck="false" list="deploy-namespaces" bind:value={namespace} />
            <datalist id="deploy-namespaces">
              {#each app.namespaces as ns (ns.name)}<option value={ns.name}></option>{/each}
            </datalist>
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={createNamespace} /> Create the namespace if it is missing
          </label>
        {:else if sources.size > 1}
          <label>
            Repository
            <select class="select" aria-label="Chart repository" value={source} onchange={(e) => pickSource(e.currentTarget.value)}>
              {#each [...sources.keys()] as s (s)}<option value={s}>{s}</option>{/each}
            </select>
          </label>
        {/if}
        <label>
          Chart version
          <select class="select" aria-label="Chart version" bind:value={version} disabled={versions.length === 0}>
            {#each versions as v (v.version)}
              <option value={v.version}
                >{v.version}{v.app_version ? ` (app ${v.app_version})` : ""}{upgrade && v.version === upgrade.version
                  ? " — current"
                  : ""}</option
              >
            {/each}
          </select>
        </label>
        {#if upgrade && source}
          <p class="muted small">From {source}; the release runs {upgrade.chart} {upgrade.version}.</p>
        {/if}
      </div>
      {#if mode === "install" && nameProblem}<p class="error-text small">{nameProblem}</p>{/if}
      {#if mode === "install" && nsProblem}<p class="error-text small">{nsProblem}</p>{/if}
      {#if sourcesError}<p class="error-text small" role="alert" data-testid="deploy-sources-error">{sourcesError}</p>{/if}
      {#if defaultsError}<p class="error-text small" role="alert">{defaultsError}</p>{/if}

      <div class="label-row">
        <span>Values</span>
        <span class="muted small"
          >{mode === "install"
            ? "The chart's defaults; change what you need."
            : "The release's own values; they replace the current ones."}</span
        >
      </div>
      <div class="pane">
        <CodeEditor value={values} label="Values" testid="deploy-values" onChange={(v) => (values = v)} />
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={reveal} /> Show Secret values in the dry run
      </label>
    {:else if step === "preview" && preview}
      <p class="lead" data-testid="deploy-summary">{preview.summary}.</p>
      {#if mode === "upgrade"}
        <div class="pane">
          <DiffView original={currentManifest} modified={preview.manifest} label="Manifest changes" />
        </div>
      {:else}
        <div class="pane">
          <CodeEditor value={preview.manifest} readonly label="Rendered manifest" testid="deploy-manifest" />
        </div>
      {/if}
      {#if preview.secrets_hidden}<p class="muted small">Secret values are hidden.</p>{/if}
      {#if preview.notes.trim()}
        <details>
          <summary>Notes</summary>
          <pre class="notes">{preview.notes}</pre>
        </details>
      {/if}
    {:else if step === "done" && result}
      <p class="lead ok" role="status" data-testid="deploy-result">{result.summary}.</p>
      {#if result.notes.trim()}
        <pre class="notes" data-testid="deploy-notes">{result.notes}</pre>
      {:else}
        <p class="muted small">The chart has no notes.</p>
      {/if}
    {/if}

    {#if helm.helmMissing}<p class="error-text small">{helm.helmMissing}</p>{/if}
    {#if error}<p class="error-text" role="alert" data-testid="deploy-error">{error}</p>{/if}

    <div class="buttons">
      {#if step === "form"}
        <button type="button" class="btn" disabled={busy} onclick={close}>Cancel</button>
        <button
          type="button"
          class="btn primary"
          data-testid="deploy-preview"
          disabled={!canPreview || !sourcesLoaded}
          onclick={runPreview}>{busy ? "Rendering…" : "Dry run"}</button
        >
      {:else if step === "preview"}
        <button type="button" class="btn" disabled={busy} onclick={back}>Back</button>
        <button type="button" class="btn" disabled={busy} onclick={close}>Cancel</button>
        <button type="button" class="btn primary" data-testid="deploy-confirm" disabled={busy} onclick={confirm}
          >{busy ? (mode === "install" ? "Installing…" : "Upgrading…") : mode === "install" ? "Install" : "Upgrade"}</button
        >
      {:else}
        {#if mode === "install"}
          <button type="button" class="btn" onclick={openRelease}>Open release</button>
        {/if}
        <button type="button" class="btn primary" onclick={close}>Close</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    width: min(860px, calc(100vw - 32px));
    height: min(720px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .dialog.compact {
    height: auto;
  }
  .dialog > :global(*) {
    flex-shrink: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    word-break: break-all;
  }
  .steps {
    font-size: 12px;
    white-space: nowrap;
  }
  .steps .on {
    color: var(--text);
    font-weight: 600;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: flex-end;
    font-size: 13px;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fields label.check,
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .label-row {
    display: flex;
    gap: 12px;
    align-items: baseline;
    font-size: 13px;
  }
  .pane {
    flex: 1;
    flex-shrink: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .lead {
    margin: 0;
    font-size: 13px;
  }
  .lead.ok {
    color: var(--green);
  }
  .small {
    font-size: 12px;
    margin: 0;
  }
  .error-text {
    margin: 0;
    font-size: 13px;
  }
  .notes {
    margin: 4px 0 0;
    padding: 8px 10px;
    max-height: 180px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    white-space: pre-wrap;
  }
  details {
    font-size: 13px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
