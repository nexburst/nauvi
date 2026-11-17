<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import CodeEditor from "../editor/CodeEditor.svelte";
  import { api, visibleCluster } from "../../cluster";
  import type { ActionAccess, HelmDeployResult, MetricsAddon, MetricsAddonId, MetricsAddonRequest } from "../../bindings";
  import { app, currentContextName, setView } from "../../stores/app.svelte";
  import { setNotice } from "../../stores/actions.svelte";
  import { checkHelm, helm, loadReleases, selectRelease } from "../../stores/helm.svelte";
  import { closeMetricsInstall, loadAddons, markInstalled } from "../../stores/metricsInstall.svelte";
  import { namespaceError, releaseNameError } from "../../helmCharts";
  import { KUBELET_INSECURE_TLS, looksLocal, sameAddonRequest } from "../../metricsAddons";
  import { HELM_VIEW } from "../../helm";

  /**
   * Install metrics-server or a small Prometheus stack (#225): a pinned
   * chart from its project's repository, with editable values, a server-side
   * dry run, and an explicit confirm that shows what goes where. Nothing is
   * installed before the confirm.
   */
  let { id }: { id: MetricsAddonId } = $props();

  const context = currentContextName();
  let addon = $state.raw<MetricsAddon | null>(null);
  let loadError = $state("");
  let step = $state<"form" | "preview" | "done">("form");
  let name = $state("");
  let namespace = $state("");
  let createNamespace = $state(true);
  let values = $state("");
  let options = $state.raw<string[]>([]);
  let reveal = $state(false);

  let access = $state.raw<ActionAccess | null>(null);
  let busy = $state(false);
  let error = $state("");
  let preview = $state.raw<HelmDeployResult | null>(null);
  let previewed = $state.raw<MetricsAddonRequest | null>(null);
  let result = $state.raw<HelmDeployResult | null>(null);

  const nameProblem = $derived(releaseNameError(name));
  const nsProblem = $derived(namespaceError(namespace));
  const denied = $derived(access && !access.allowed ? access.reason : "");
  const request = $derived<MetricsAddonRequest>({
    addon: id,
    name,
    namespace,
    values,
    options,
    create_namespace: createNamespace,
    dry_run: true,
    reveal,
  });
  const canPreview = $derived(!!addon && !busy && !helm.helmMissing && !nameProblem && !nsProblem && !denied);
  const title = $derived(`Install ${addon?.title ?? id}`);

  onMount(() => {
    void checkHelm();
    void loadAddons().then(
      (all) => {
        const a = all.find((x) => x.id === id);
        if (!a) {
          loadError = `Unknown add-on ${id}.`;
          return;
        }
        addon = a;
        name = a.release;
        namespace = a.namespace;
        values = a.values;
      },
      (e) => (loadError = String(e)),
    );
  });

  // RBAC for the chosen namespace, checked shortly after it changes.
  let accessTimer: ReturnType<typeof setTimeout> | null = null;
  let accessSeq = 0;
  $effect(() => {
    const ns = namespace;
    if (!addon || namespaceError(ns)) return;
    untrack(() => {
      if (accessTimer) clearTimeout(accessTimer);
      const n = ++accessSeq;
      accessTimer = setTimeout(() => {
        api(visibleCluster()).cmdMetricsAddonAccess(id, ns).then(
          (a) => n === accessSeq && (access = a),
          () => n === accessSeq && (access = null),
        );
      }, 250);
    });
  });
  onDestroy(() => {
    if (accessTimer) clearTimeout(accessTimer);
  });

  function toggleOption(opt: string, on: boolean) {
    options = on ? [...options.filter((o) => o !== opt), opt] : options.filter((o) => o !== opt);
  }

  function resetValues() {
    if (addon) values = addon.values;
  }

  async function runPreview() {
    if (!canPreview) return;
    busy = true;
    error = "";
    const req = { ...request };
    try {
      preview = await api(visibleCluster()).cmdMetricsAddonInstall(req);
      previewed = req;
      step = "preview";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    if (!previewed || busy || !sameAddonRequest(previewed, request)) return;
    busy = true;
    error = "";
    try {
      result = await api(visibleCluster()).cmdMetricsAddonInstall({ ...previewed, dry_run: false });
      step = "done";
      setNotice(true, result.summary);
      markInstalled();
      helm.nonce += 1;
      void loadReleases(app.selectedNamespaces);
      // Look for the new Prometheus now rather than when the cache expires.
      if (id === "prometheus") void api(visibleCluster()).cmdPrometheusStatus(true).catch(() => {});
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
    closeMetricsInstall();
    setView(HELM_VIEW);
    selectRelease(sel);
  }

  function close() {
    if (!busy) closeMetricsInstall();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !e.defaultPrevented) close();
  }

  const optionLabel = (o: string) => addon?.options.find((x) => x.id === o)?.arg ?? o;
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
  <div
    class="dialog"
    class:compact={step === "done" || !addon}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    data-testid="metrics-install"
  >
    <div class="head">
      <h2>{title}</h2>
      <span class="steps muted" data-testid="addon-step">
        <span class:on={step === "form"}>1 Values</span> ›
        <span class:on={step === "preview"}>2 Dry run and confirm</span> ›
        <span class:on={step === "done"}>3 Installed</span>
      </span>
    </div>

    {#if loadError}
      <p class="error-text" role="alert">{loadError}</p>
    {:else if !addon}
      <p class="muted small">Loading…</p>
    {:else if step === "form"}
      <p class="lead">{addon.summary}</p>
      <dl class="facts" data-testid="addon-chart">
        <dt>Chart</dt>
        <dd class="mono">{addon.chart} {addon.version} <span class="muted">(app {addon.app_version})</span></dd>
        <dt>Repository</dt>
        <dd class="mono">{addon.repo_url}</dd>
        <dt>Installs</dt>
        <dd>{addon.components.join(", ")}</dd>
      </dl>
      <div class="fields">
        <label>
          Release name
          <input class="input mono" aria-label="Release name" spellcheck="false" bind:value={name} />
        </label>
        <label>
          Namespace
          <input class="input mono" aria-label="Namespace" spellcheck="false" list="addon-namespaces" bind:value={namespace} />
          <datalist id="addon-namespaces">
            {#each app.namespaces as ns (ns.name)}<option value={ns.name}></option>{/each}
          </datalist>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={createNamespace} /> Create the namespace if it is missing
        </label>
      </div>
      {#if nameProblem}<p class="error-text small">{nameProblem}</p>{/if}
      {#if nsProblem}<p class="error-text small">{nsProblem}</p>{/if}
      {#each addon.options as opt (opt.id)}
        <div class="option">
          <label class="check">
            <input
              type="checkbox"
              data-testid="addon-option-{opt.id}"
              checked={options.includes(opt.id)}
              onchange={(e) => toggleOption(opt.id, e.currentTarget.checked)}
            />
            {opt.label}
          </label>
          <p class="muted small">{opt.detail}</p>
          {#if opt.id === KUBELET_INSECURE_TLS && looksLocal(context)}
            <p class="hint small" data-testid="addon-local-hint">
              {context} looks like a local cluster: metrics-server stays unready there without this.
            </p>
          {/if}
        </div>
      {/each}
      <div class="label-row">
        <span>Values</span>
        <span class="muted small">kubeloupe's starting values over the chart's defaults; change what you need.</span>
        <button type="button" class="btn small-btn" onclick={resetValues} disabled={values === addon.values}>Reset</button>
      </div>
      <div class="pane">
        <CodeEditor value={values} label="Values" testid="addon-values" onChange={(v) => (values = v)} />
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={reveal} /> Show Secret values in the dry run
      </label>
      {#if denied}<p class="error-text small" role="alert" data-testid="addon-denied">{denied}</p>{/if}
    {:else if step === "preview" && preview && previewed}
      <p class="lead" data-testid="addon-summary">{preview.summary}.</p>
      <dl class="facts confirm" data-testid="addon-confirm-facts">
        <dt>Chart</dt>
        <dd class="mono">{addon.chart} {addon.version}</dd>
        <dt>Repository</dt>
        <dd class="mono" data-testid="addon-repo">{addon.repo_url}</dd>
        <dt>Into</dt>
        <dd class="mono">{previewed.namespace}/{previewed.name} on {context || "the current context"}</dd>
        <dt>Options</dt>
        <dd class="mono">{previewed.options.length ? previewed.options.map(optionLabel).join(" ") : "none"}</dd>
      </dl>
      <div class="pane">
        <CodeEditor value={preview.manifest} readonly label="Rendered manifest" testid="addon-manifest" />
      </div>
      {#if preview.secrets_hidden}<p class="muted small">Secret values are hidden.</p>{/if}
      <p class="muted small">Nothing has been installed yet. Install runs helm install with exactly these settings.</p>
    {:else if step === "done" && result}
      <p class="lead ok" role="status" data-testid="addon-result">{result.summary}.</p>
      <p class="muted small" data-testid="addon-next">
        {#if id === "metrics-server"}
          Usage shows up once metrics-server is ready, usually within a minute or two.
        {:else}
          The usage charts use it once its pods are ready; the Disk column on Nodes follows after its first scrapes.
        {/if}
      </p>
    {/if}

    {#if helm.helmMissing}<p class="error-text small">{helm.helmMissing}</p>{/if}
    {#if error}<p class="error-text" role="alert" data-testid="addon-error">{error}</p>{/if}

    <div class="buttons">
      {#if step === "form"}
        <button type="button" class="btn" disabled={busy} onclick={close}>Cancel</button>
        <button
          type="button"
          class="btn primary"
          data-testid="addon-preview"
          disabled={!canPreview}
          title={denied || undefined}
          onclick={runPreview}>{busy ? "Rendering…" : "Dry run"}</button
        >
      {:else if step === "preview"}
        <button type="button" class="btn" disabled={busy} onclick={back}>Back</button>
        <button type="button" class="btn" disabled={busy} onclick={close}>Cancel</button>
        <button type="button" class="btn primary" data-testid="addon-confirm" disabled={busy} onclick={confirm}
          >{busy ? "Installing…" : "Install"}</button
        >
      {:else}
        <button type="button" class="btn" onclick={openRelease}>Open release</button>
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
    height: min(740px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    overflow: auto;
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
  }
  .steps {
    font-size: 12px;
    white-space: nowrap;
  }
  .steps .on {
    color: var(--text);
    font-weight: 600;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 0;
    font-size: 13px;
  }
  .facts dt {
    color: var(--text-muted);
  }
  .facts dd {
    margin: 0;
    word-break: break-all;
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
  .option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .option .small {
    margin-left: 22px;
  }
  .hint {
    color: var(--amber);
  }
  .label-row {
    display: flex;
    gap: 12px;
    align-items: baseline;
    font-size: 13px;
  }
  .small-btn {
    margin-left: auto;
    font-size: 12px;
  }
  .pane {
    flex: 1;
    flex-shrink: 1;
    min-height: 140px;
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
