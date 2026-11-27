<script lang="ts">
  import AgentSettings from "./AgentSettings.svelte";
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
  import AskAiSettings from "./AskAiSettings.svelte";
  import { loadCharts } from "../stores/helmCharts.svelte";
  import { checkForUpdates, updates } from "../stores/updates.svelte";
  import { checkSummary } from "../updates";
  import { help } from "../stores/help.svelte";
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

  // One section at a time (the list on the left), or every one that has the
  // searched text. "All settings" is the whole page in one scroll.
  const SECTIONS = [
    { id: "appearance", label: "Appearance" },
    { id: "editor", label: "Editor and logs" },
    { id: "app", label: "Startup and updates" },
    { id: "clusters", label: "Clusters" },
    { id: "metrics", label: "Metrics" },
    { id: "helm", label: "Helm" },
    { id: "agents", label: "Agents (MCP)" },
    { id: "about", label: "About nauvi" },
    { id: "all", label: "All settings" },
  ];
  const SECTION_KEY = "nauvi.settings.section";

  function lastSection(): string {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SECTION_KEY);
    } catch {
      // Storage blocked: the first section.
    }
    if (saved === "all") return saved;
    // Help → About opens this page on About (AboutSection clears the flag).
    if (help.showAbout) return "about";
    return SECTIONS.some((s) => s.id === saved) ? saved! : SECTIONS[0].id;
  }

  let section = $state(lastSection());
  let q = $state("");
  const searching = $derived(q.trim() !== "");
  const on = (id: string) => searching || section === "all" || section === id;
  let pane = $state<HTMLElement | null>(null);
  let matches = $state(1);

  function pick(id: string) {
    section = id;
    q = "";
    pane?.scrollTo({ top: 0 });
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      // Storage blocked: remembered for this window only.
    }
  }

  // The search keeps the sections that have the text anywhere in them.
  $effect(() => {
    const needle = q.trim().toLowerCase();
    let n = 0;
    for (const f of pane?.querySelectorAll("fieldset") ?? []) {
      const miss = needle !== "" && !(f.textContent ?? "").toLowerCase().includes(needle);
      f.classList.toggle("nomatch", miss);
      if (!miss) n++;
    }
    matches = n;
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
      <button type="button" class="x" title="Close (Esc)" use:focus onclick={closeSettings}><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg><span class="sr">Close</span></button>
    </div>

    <div class="body">
      <div class="side">
        <input class="input search" type="search" aria-label="Search settings" placeholder="Search settings" bind:value={q} />
        <div class="tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {#each SECTIONS as s (s.id)}
            <button
              type="button"
              role="tab"
              class="tab"
              class:all={s.id === "all"}
              aria-selected={!searching && section === s.id}
              onclick={() => pick(s.id)}>{s.label}</button
            >
          {/each}
        </div>
      </div>
      <div class="pane" bind:this={pane} data-testid="settings-pane">
    <fieldset hidden={!on("appearance")}>
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

    <fieldset data-testid="zoom-settings" hidden={!on("appearance")}>
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

    <fieldset data-testid="kubectl-settings" hidden={!on("editor")}>
      <legend>Local terminal</legend>
      <label class="choice">
        <input
          type="checkbox"
          checked={current.kubectl_match}
          onchange={(e) => updateSettings({ kubectl_match: e.currentTarget.checked })}
        />
        Offer a kubectl that matches the cluster
      </label>
      <p class="muted hint">
        When your kubectl is more than one minor version from the cluster, a local terminal offers to download the
        matching one from dl.k8s.io. Its SHA-256 is checked against the one dl.k8s.io itself publishes: that catches
        a corrupted download, not a compromised dl.k8s.io. It is used only in this app's local terminals, never in
        place of your own.
      </p>
    </fieldset>

    <fieldset data-testid="editor-settings" hidden={!on("editor")}>
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

    <fieldset hidden={!on("editor")}>
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

    <fieldset data-testid="time-settings" hidden={!on("appearance")}>
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

    <fieldset data-testid="idle-settings" hidden={!on("clusters")}>
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

    <fieldset data-testid="registry-tags-settings" hidden={!on("clusters")}>
      <legend>Container images</legend>
      <label class="choice">
        <input
          type="checkbox"
          checked={current.registry_tags}
          onchange={(e) => updateSettings({ registry_tags: e.currentTarget.checked })}
        />
        Show available tags
      </label>
      <p class="muted hint">
        Adds an Available tags button by each image in the pod and workload panels. A click asks the image's registry,
        from this computer and over HTTPS only, which newer tags it has. Private registries use your docker login,
        never the cluster's pull secrets. Nothing is asked until you click.
      </p>
    </fieldset>

    {#if context}
      <fieldset hidden={!on("clusters")}>
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

    <fieldset data-testid="prometheus-settings" hidden={!on("metrics")}>
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

    <fieldset data-testid="helm-repo-settings" hidden={!on("helm")}>
      <legend>Helm repositories</legend>
      <HelmRepos />
      <p class="muted hint">Shared with the helm command line (its repositories.yaml). Charts are under Helm → Charts.</p>
    </fieldset>

    <fieldset data-testid="startup-settings" hidden={!on("app")}>
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

    <fieldset data-testid="update-settings" hidden={!on("app")}>
      <legend>Updates</legend>
      <label class="choice">
        <input
          type="checkbox"
          checked={current.check_updates}
          onchange={(e) => updateSettings({ check_updates: e.currentTarget.checked })}
        />
        Check for updates automatically
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
        The check asks GitHub for the latest release: on start, then about every 12 hours while nauvi is open. Nothing is downloaded or installed until you click Install and
        restart.
      </p>
    </fieldset>

    <fieldset data-testid="layout-settings" hidden={!on("appearance")}>
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

    <div hidden={!on("agents")}><AskAiSettings /></div>
    <div hidden={!on("agents")}><AgentSettings /></div>

    <div hidden={!on("about")}><AboutSection /></div>
        {#if matches === 0}<p class="muted none">No setting matches "{q.trim()}".</p>{/if}
      </div>
    </div>
  </div>
</div>

<style>
  .x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 13px;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    cursor: pointer;
  }
  .x {
    position: relative;
  }
  .x svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .x:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
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
    width: min(860px, calc(100vw - 32px));
    height: min(620px, calc(100vh - 64px));
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 10px;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
    border-bottom-left-radius: 8px;
  }
  .search {
    width: 100%;
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .tab {
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .tab:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .tab[aria-selected="true"] {
    background: var(--accent-soft);
    color: var(--accent);
  }
  /* "All settings" sits apart, at the foot of the list. */
  .tab.all {
    margin-top: auto;
  }
  .pane {
    min-height: 0;
    overflow-y: auto;
    padding: 2px 20px 18px;
  }
  .pane :global(fieldset.nomatch),
  fieldset[hidden] {
    display: none;
  }
  .none {
    margin: 16px 0 0;
    font-size: 13px;
  }
  /* A narrow window: the sections above the page, in a row. */
  @media (max-width: 620px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .side {
      border-right: none;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
    }
    .tabs {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .tab.all {
      margin-top: 0;
    }
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
