<script lang="ts">
  import { onMount } from "svelte";
  import { api, visibleCluster } from "../cluster";
  import { commands } from "../bindings";
  import type { PrometheusStatus, RowHeight, Theme, TimeZone } from "../bindings";
  import { DEFAULT_DETAIL_WIDTH, prometheusSettingError, TAIL_OPTIONS } from "../settings";
  import type { LogDefaults } from "../settings";
  import { currentContextName } from "../stores/app.svelte";
  import { closeSettings } from "../stores/keyboard.svelte";
  import { contextLabel, openClusterSettings } from "../stores/catalog.svelte";
  import {
    applyAppearance,
    contextSettings,
    settings,
    updateContext,
    updateSettings,
    zoomIn,
    zoomOut,
    zoomReset,
  } from "../stores/settings.svelte";
  import HelmRepos from "./helm/HelmRepos.svelte";
  import MetricsOffer from "./helm/MetricsOffer.svelte";
  import AboutSection from "./AboutSection.svelte";
  import { loadCharts } from "../stores/helmCharts.svelte";
  import { checkForUpdates, updates } from "../stores/updates.svelte";
  import { checkSummary } from "../updates";
  import { isMacPlatform, shortcutHint } from "../keys";
  import { clampTerminalFont, DEFAULT_ZOOM, MAX_TERMINAL_FONT, MIN_TERMINAL_FONT, ZOOM_STEPS } from "../zoom";
  import { clampEditorFont, MAX_EDITOR_FONT, MIN_EDITOR_FONT, ROW_HEIGHTS, TAB_SIZES } from "../preferences";
  import { clusterStateText, IDLE_CHOICES, idleChoiceLabel } from "../idle";
  import { backgroundClusters } from "../stores/clusterStates.svelte";

  const mac = isMacPlatform();
  const zoomHint = `${shortcutHint("zoomIn", mac)}, ${shortcutHint("zoomOut", mac)} and ${shortcutHint("zoomReset", mac)} zoom this window; other windows take the zoom when they open`;

  /** The Settings page (gear in the header, Mod+, or the palette). Every
   *  change applies and is saved at once. */
  const current = $derived(settings.current);

  const THEMES: { value: Theme; label: string }[] = [
    { value: "system", label: "System" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];

  function setTheme(theme: Theme) {
    updateSettings({ theme });
    applyAppearance();
  }

  function setLogs(change: Partial<LogDefaults>) {
    updateSettings({ logs: { ...current.logs, ...change } });
  }

  function resetWidth() {
    updateSettings({ detail_width: DEFAULT_DETAIL_WIDTH });
    applyAppearance();
  }

  const ZONES: { value: TimeZone; label: string }[] = [
    { value: "local", label: "Local time" },
    { value: "utc", label: "UTC" },
  ];

  // Start at login (#330) lives in the OS (an autostart entry), not in the
  // settings file: read it when the page opens.
  let autostart = $state<boolean | null>(null);
  let autostartError = $state("");
  let autostartBusy = $state(false);

  async function readAutostart() {
    try {
      autostart = await commands.cmdAutostartEnabled();
      autostartError = "";
    } catch (e) {
      autostartError = String(e);
    }
  }

  async function setAutostart(box: HTMLInputElement) {
    const enabled = box.checked;
    autostartBusy = true;
    try {
      autostart = await commands.cmdAutostartSet(enabled);
      autostartError = "";
    } catch (e) {
      await readAutostart();
      autostartError = String(e);
    } finally {
      autostartBusy = false;
      // Show what the OS has, also when the change failed.
      box.checked = autostart === true;
    }
  }

  const tailLabel = (t: string) => (t === "all" ? "All lines" : `${t} lines`);

  // Prometheus (#47) is set per context: the current one.
  const context = currentContextName();
  // svelte-ignore state_referenced_locally
  let promValue = $state(contextSettings(context).prometheus ?? "");
  const promError = $derived(prometheusSettingError(promValue));
  let promStatus = $state<PrometheusStatus | null>(null);
  let promStatusError = $state("");
  let promChecking = $state(false);

  async function checkPrometheus(redetect: boolean) {
    promChecking = true;
    try {
      promStatus = await api(visibleCluster()).cmdPrometheusStatus(redetect);
      promStatusError = "";
    } catch (e) {
      promStatusError = String(e);
    } finally {
      promChecking = false;
    }
  }

  async function savePrometheus() {
    const value = promValue.trim();
    if (promError || value === (contextSettings(context).prometheus ?? "")) return;
    // The backend detects again once it has the new value.
    await updateContext(context, { prometheus: value });
    await checkPrometheus(false);
  }

  onMount(() => {
    void readAutostart();
    void checkPrometheus(false);
    void loadCharts();
  });

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeSettings()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings">
    <div class="head">
      <h2>Settings</h2>
      <button type="button" class="btn" use:focus onclick={closeSettings}>Close</button>
    </div>

    <fieldset>
      <legend>Theme</legend>
      <div class="choices" role="radiogroup" aria-label="Theme">
        {#each THEMES as t (t.value)}
          <label class="choice">
            <input
              type="radio"
              name="theme"
              value={t.value}
              checked={current.theme === t.value}
              onchange={() => setTheme(t.value)}
            />
            {t.label}
          </label>
        {/each}
      </div>
      <p class="muted hint">System follows your desktop's light or dark preference.</p>
    </fieldset>

    <fieldset data-testid="zoom-settings">
      <legend>Zoom and text</legend>
      <div class="row">
        <span>Zoom: <span data-testid="zoom-level">{current.zoom}%</span></span>
        <span class="buttons">
          <button type="button" class="btn" aria-label="Zoom out" disabled={current.zoom <= ZOOM_STEPS[0]} onclick={zoomOut}
            >−</button
          >
          <button
            type="button"
            class="btn"
            aria-label="Zoom in"
            disabled={current.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onclick={zoomIn}>+</button
          >
          <button type="button" class="btn" disabled={current.zoom === DEFAULT_ZOOM} onclick={zoomReset}>Reset</button>
        </span>
      </div>
      <label class="row">
        <span>Terminal font size</span>
        <span class="buttons">
          <input
            class="input font"
            type="number"
            aria-label="Terminal font size"
            min={MIN_TERMINAL_FONT}
            max={MAX_TERMINAL_FONT}
            value={current.terminal_font_size}
            onchange={(e) => {
              const size = clampTerminalFont(e.currentTarget.valueAsNumber);
              e.currentTarget.value = String(size);
              updateSettings({ terminal_font_size: size });
            }}
          />
          px
        </span>
      </label>
      <p class="muted hint">
        {zoomHint}. The terminal font size applies to open terminals at once.
      </p>
    </fieldset>

    <fieldset data-testid="editor-settings">
      <legend>YAML editor</legend>
      <label class="row">
        <span>Font size</span>
        <span class="buttons">
          <input
            class="input font"
            type="number"
            aria-label="Editor font size"
            min={MIN_EDITOR_FONT}
            max={MAX_EDITOR_FONT}
            value={current.editor_font_size}
            onchange={(e) => {
              const size = clampEditorFont(e.currentTarget.valueAsNumber);
              e.currentTarget.value = String(size);
              updateSettings({ editor_font_size: size });
            }}
          />
          px
        </span>
      </label>
      <label class="row">
        <span>Tab size</span>
        <select
          class="select"
          aria-label="Editor tab size"
          value={String(current.editor_tab_size)}
          onchange={(e) => updateSettings({ editor_tab_size: Number(e.currentTarget.value) })}
        >
          {#each TAB_SIZES.includes(current.editor_tab_size) ? TAB_SIZES : [...TAB_SIZES, current.editor_tab_size] as n (n)}
            <option value={String(n)}>{n} spaces</option>
          {/each}
        </select>
      </label>
      <p class="muted hint">Tab and Enter indent by the tab size. Both apply to open editors at once.</p>
    </fieldset>

    <fieldset>
      <legend>Log defaults</legend>
      <label class="row">
        <span>Tail</span>
        <select
          class="select"
          aria-label="Default tail lines"
          value={TAIL_OPTIONS.includes(current.logs.tail) ? current.logs.tail : "200"}
          onchange={(e) => setLogs({ tail: e.currentTarget.value })}
        >
          {#each TAIL_OPTIONS as t (t)}
            <option value={t}>{tailLabel(t)}</option>
          {/each}
        </select>
      </label>
      <label class="choice">
        <input
          type="checkbox"
          checked={current.logs.timestamps}
          onchange={(e) => setLogs({ timestamps: e.currentTarget.checked })}
        />
        Show timestamps
      </label>
      <label class="choice">
        <input type="checkbox" checked={current.logs.wrap} onchange={(e) => setLogs({ wrap: e.currentTarget.checked })} />
        Wrap long lines
      </label>
    </fieldset>

    <fieldset data-testid="time-settings">
      <legend>Times</legend>
      <div class="choices" role="radiogroup" aria-label="Time zone">
        {#each ZONES as z (z.value)}
          <label class="choice">
            <input
              type="radio"
              name="time-zone"
              value={z.value}
              checked={current.time_zone === z.value}
              onchange={() => updateSettings({ time_zone: z.value })}
            />
            {z.label}
          </label>
        {/each}
      </div>
      <p class="muted hint">
        For the clocks in usage charts, notifications and the footer, and for HH:MM in the log viewer's Jump to time.
        Log lines keep the time they were written with.
      </p>
    </fieldset>

    <fieldset data-testid="idle-settings">
      <legend>Background clusters</legend>
      <label class="row">
        <span>Disconnect when idle for</span>
        <select
          class="select"
          aria-label="Disconnect idle clusters after"
          value={String(current.idle_disconnect_minutes)}
          onchange={(e) => updateSettings({ idle_disconnect_minutes: Number(e.currentTarget.value) })}
        >
          {#each IDLE_CHOICES.includes(current.idle_disconnect_minutes) ? IDLE_CHOICES : [current.idle_disconnect_minutes, ...IDLE_CHOICES] as n (n)}
            <option value={String(n)}>{idleChoiceLabel(n)}</option>
          {/each}
        </select>
      </label>
      {#if backgroundClusters(context).length}
        <ul class="background" data-testid="background-clusters">
          {#each backgroundClusters(context) as c (c.cluster)}
            <li>
              <span class="name">{contextLabel(c.cluster)}</span>
              <span class="muted">{clusterStateText(c)}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="muted hint">
        A cluster this window is connected to but does not show is disconnected after this long untouched, unless a
        port-forward, terminal, log stream or drain runs there. Using it connects it again. Clusters that sign in
        through a plugin stay connected.
      </p>
    </fieldset>

    {#if context}
      <fieldset>
        <legend>This cluster</legend>
        <div class="row">
          <span class="muted status">Display name, colour, namespaces and the local terminal's folder.</span>
          <button
            type="button"
            class="btn"
            onclick={() => {
              closeSettings();
              openClusterSettings(context);
            }}>Settings for {contextLabel(context)}…</button
          >
        </div>
      </fieldset>
    {/if}

    <fieldset data-testid="prometheus-settings">
      <legend>Prometheus</legend>
      <label class="row">
        <span>Service{context ? ` for ${context}` : ""}</span>
        <input
          class="input prom"
          aria-label="Prometheus Service"
          placeholder="Detect automatically"
          spellcheck="false"
          bind:value={promValue}
          onchange={savePrometheus}
          onkeydown={(e) => e.key === "Enter" && savePrometheus()}
        />
      </label>
      {#if promError}
        <p class="hint error" data-testid="prometheus-error">{promError}</p>
      {/if}
      <div class="row">
        <span class="muted status" data-testid="prometheus-status">
          {#if promStatusError}
            Could not check: {promStatusError}
          {:else if !promStatus}
            Checking…
          {:else if promStatus.target}
            Using {promStatus.target}{promStatus.from_settings ? " (from Settings)" : " (detected)"}.
          {:else}
            {promStatus.note}
          {/if}
        </span>
        <button type="button" class="btn" disabled={promChecking} onclick={() => checkPrometheus(true)}
          >Detect again</button
        >
      </div>
      {#if promStatus && !promStatus.target && !promStatus.from_settings && !promValue.trim()}
        <MetricsOffer
          addon="prometheus"
          label="Install Prometheus…"
          text="None here? Install a small one (Prometheus, kube-state-metrics, node-exporter) with helm."
          onopen={closeSettings}
        />
      {/if}
      <p class="muted hint">
        Usage charts show 1h, 6h and 24h from Prometheus, through the API server's service proxy. Leave empty to detect
        it, type namespace/service:port to choose one, or off to use only metrics-server.
      </p>
    </fieldset>

    <fieldset data-testid="helm-repo-settings">
      <legend>Helm repositories</legend>
      <HelmRepos />
      <p class="muted hint">Shared with the helm command line (its repositories.yaml). Charts are under Helm → Charts.</p>
    </fieldset>

    <fieldset data-testid="startup-settings">
      <legend>Startup</legend>
      <label class="choice">
        <input
          type="checkbox"
          aria-label="Start at login"
          checked={autostart === true}
          disabled={autostart === null || autostartBusy}
          onchange={(e) => setAutostart(e.currentTarget)}
        />
        Start nauvi when you log in
      </label>
      {#if autostartError}
        <p class="hint error" data-testid="autostart-error">{autostartError}</p>
      {/if}
      <p class="muted hint">Off unless you turn it on. Adds the app to your desktop's startup applications.</p>
    </fieldset>

    <fieldset data-testid="update-settings">
      <legend>Updates</legend>
      <label class="choice">
        <input
          type="checkbox"
          checked={current.check_updates}
          onchange={(e) => updateSettings({ check_updates: e.currentTarget.checked })}
        />
        Check for updates on start
      </label>
      <div class="row">
        <span class="muted status" data-testid="update-status">
          {#if updates.checking}
            Checking…
          {:else if updates.checkError}
            {updates.checkError}
          {:else if updates.check}
            {checkSummary(updates.check)}
          {:else}
            Not checked yet.
          {/if}
        </span>
        <button type="button" class="btn" disabled={updates.checking} onclick={() => checkForUpdates(false)}
          >Check for updates</button
        >
      </div>
      <p class="muted hint">
        The check asks GitHub for the latest release. Nothing is downloaded or installed until you click Install and
        restart.
      </p>
    </fieldset>

    <fieldset data-testid="layout-settings">
      <legend>Layout</legend>
      <div class="row">
        <span>Table rows</span>
        <div class="choices" role="radiogroup" aria-label="Table row height">
          {#each ROW_HEIGHTS as r (r.value)}
            <label class="choice">
              <input
                type="radio"
                name="row-height"
                value={r.value}
                checked={current.row_height === r.value}
                onchange={() => updateSettings({ row_height: r.value as RowHeight })}
              />
              {r.label}
            </label>
          {/each}
        </div>
      </div>
      <div class="row">
        <span>Detail panel width: {current.detail_width}px</span>
        <button type="button" class="btn" disabled={current.detail_width === DEFAULT_DETAIL_WIDTH} onclick={resetWidth}
          >Reset</button
        >
      </div>
      <p class="muted hint">
        Drag the panel's left edge to resize it. The last context, view and namespaces, and each table's sort and
        columns, are remembered too.
      </p>
    </fieldset>

    <AboutSection />
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow-y: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
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
  .choices {
    display: flex;
    gap: 16px;
  }
  .choice,
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .row {
    justify-content: space-between;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .hint.error {
    color: var(--red);
  }
  .input.prom {
    width: 260px;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .input.font {
    width: 64px;
  }
  .status {
    font-size: 12px;
  }
  .background {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .background li {
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .background .name {
    flex: none;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
