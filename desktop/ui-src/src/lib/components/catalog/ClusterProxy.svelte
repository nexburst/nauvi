<script lang="ts">
  import { commands } from "../../bindings";
  import type { ClusterProxyInfo } from "../../bindings";
  import { visibleCluster } from "../../cluster";
  import { reconnectCluster } from "../../stores/app.svelte";
  import { closeClusterSettings } from "../../stores/catalog.svelte";
  import { live } from "../../stores/live.svelte";
  import { confirmDiscard } from "../../stores/unsaved.svelte";

  /** The cluster's proxy (#329), a section of its settings page. The backend
   *  keeps the URL; this only ever gets it with the user and password masked,
   *  so the field starts empty and a new URL replaces the saved one. */
  let { id }: { id: string } = $props();

  let info = $state<ClusterProxyInfo | null>(null);
  let url = $state("");
  /** A new CA file for an https:// proxy (#362); "" keeps the saved one. */
  let caFile = $state("");
  let local = $state(false);
  let error = $state("");
  let saving = $state(false);
  let field = $state<HTMLInputElement>();
  /** Set once the proxy changed: it applies from the next connection. */
  let changed = $state(false);

  // svelte-ignore state_referenced_locally
  const shown = id === visibleCluster();

  /** Whether the app's proxy applies: else the kubeconfig's proxy-url, if any. */
  const settingApplies = $derived(!!info?.url && (info.local || !info.server_local));
  /** The proxy typed, else the saved one, is https://: it may have a CA file. */
  const https = $derived(/^https:\/\//i.test(url.trim() || info?.url || ""));
  const canSave = $derived(!!url.trim() || (https && !!caFile.trim()));

  async function load() {
    try {
      info = await commands.cmdGetClusterProxy(id);
      local = info.local;
    } catch (e) {
      error = String(e);
    }
  }
  void load();

  /** `ca`: a CA file, "" for none, null to keep the saved one. */
  async function save(next: string | null, nextLocal = local, ca: string | null = null) {
    saving = true;
    try {
      info = await commands.cmdSetClusterProxy(id, next, nextLocal, ca);
      local = info.local;
      error = "";
      url = "";
      caFile = "";
      changed = true;
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
      // The button pressed may be disabled or gone now: keep the focus in
      // the dialog, so Escape still closes it.
      field?.focus();
    }
  }

  function onLocal(checked: boolean) {
    local = checked;
    // Saved at once when a proxy is set; else with the URL.
    if (info?.url) void save(null, checked);
  }

  /** Save what was typed: a new URL and/or a new CA file. */
  function saveTyped() {
    const ca = https && caFile.trim() ? caFile.trim() : null;
    void save(url.trim() ? url : null, local, ca);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && canSave) {
      e.preventDefault();
      saveTyped();
    }
  }

  /** A fresh session on this cluster, as opening it from the catalog. */
  async function reconnect() {
    // Read before the dialog closes: its props are gone after that.
    const cluster = id;
    if (!(await confirmDiscard())) return;
    closeClusterSettings();
    if (cluster === visibleCluster()) live.stop();
    await reconnectCluster(cluster);
  }
</script>

<fieldset data-testid="cluster-proxy">
  <legend>Network</legend>
  {#if info}
    <p class="hint route" data-testid="proxy-route">{info.route}</p>
    {#if info.url}
      <div class="row">
        <span>Proxy {settingApplies ? "(in effect)" : "(not used)"}</span>
        <span class="current mono" data-testid="proxy-current">{info.url}</span>
      </div>
    {/if}
    {#if info.url && info.ca_file}
      <div class="row">
        <span>Proxy CA file</span>
        <span class="current mono" data-testid="proxy-ca">{info.ca_file}</span>
      </div>
    {/if}
    {#if info.kubeconfig_proxy}
      <div class="row">
        <span>Kubeconfig proxy {settingApplies ? "(replaced)" : "(in effect)"}</span>
        <span class="current mono" data-testid="proxy-kubeconfig">{info.kubeconfig_proxy}</span>
      </div>
    {/if}
  {/if}
  <label class="row">
    <span>{info?.url ? "New proxy URL" : "Proxy URL"}</span>
    <input
      class="input mono"
      aria-label="Proxy URL"
      placeholder="http://proxy.example:3128"
      spellcheck="false"
      autocomplete="off"
      bind:value={url}
      bind:this={field}
      {onkeydown}
    />
  </label>
  {#if https}
    <label class="row">
      <span>{info?.ca_file ? "New proxy CA file" : "Proxy CA file (optional)"}</span>
      <input
        class="input mono"
        aria-label="Proxy CA file"
        placeholder="/path/to/proxy-ca.pem"
        spellcheck="false"
        autocomplete="off"
        bind:value={caFile}
        {onkeydown}
      />
    </label>
  {/if}
  <label class="choice">
    <input
      type="checkbox"
      aria-label="Use the proxy for a cluster on this machine"
      checked={local}
      onchange={(e) => onLocal(e.currentTarget.checked)}
    />
    Also for a cluster on this machine (localhost, 127.0.0.1)
  </label>
  {#if error}<p class="hint error-text" data-testid="proxy-error">{error}</p>{/if}
  <div class="actions">
    <button type="button" class="btn" disabled={saving || !canSave} onclick={saveTyped}>Save proxy</button>
    {#if info?.url && info.ca_file}
      <button type="button" class="btn" disabled={saving} onclick={() => save(null, local, "")}>Remove CA file</button>
    {/if}
    {#if info?.url}
      <button type="button" class="btn" disabled={saving} onclick={() => save("")}>Remove proxy</button>
    {/if}
  </div>
  {#if changed}
    <p class="hint" data-testid="proxy-applies">
      Used from the next time a window connects to this cluster.
      {#if shown}<button type="button" class="link" onclick={reconnect}>Reconnect now</button>{/if}
    </p>
  {/if}
  <p class="muted hint">
    An http://, https:// or socks5:// proxy for every request, watch, terminal and port-forward of this cluster,
    instead of the kubeconfig's proxy-url. A user name and password go in the URL (http://user:password@host:port);
    nauvi keeps them in its own config folder, never in the kubeconfig, and shows them masked. An https:// proxy's
    certificate is checked against the system's trust store and the CA file set here, never the cluster's certificate
    authority, and the proxy never gets the cluster's client certificate. Helm and local terminals do not use it.
  </p>
</fieldset>

<style>
  fieldset {
    border: none;
    padding: 0;
    margin: 16px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
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
  .row .input {
    width: 280px;
  }
  .current {
    font-size: 12px;
    word-break: break-all;
    text-align: right;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
</style>
