<script lang="ts">
  import { CLUSTER_COLORS, displayName, namespaceError, parseNamespaceList } from "../../catalog";
  import { prometheusSettingError } from "../../settings";
  import type { ContextSettings } from "../../settings";
  import { app } from "../../stores/app.svelte";
  import { closeClusterSettings, isPinned, togglePin } from "../../stores/catalog.svelte";
  import { contextSettings, updateContext } from "../../stores/settings.svelte";

  /** One cluster's settings page (#78): its name and colour in kubeloupe,
   *  namespaces, Prometheus and local shell folder. Each field is saved when
   *  it changes, if it is valid. */
  let { id }: { id: string } = $props();

  // svelte-ignore state_referenced_locally
  const saved = contextSettings(id);
  // svelte-ignore state_referenced_locally
  const ctx = app.contexts.find((c) => c.name === id);

  let name = $state(saved.display_name);
  let defaultNs = $state(saved.default_namespace);
  let accessible = $state(saved.typed_namespaces.join(", "));
  let prometheus = $state(saved.prometheus);
  let shellCwd = $state(saved.shell_cwd);

  const defaultNsError = $derived(namespaceError(defaultNs.trim()));
  const accessibleError = $derived(
    parseNamespaceList(accessible)
      .map(namespaceError)
      .find((e) => e) ?? "",
  );
  const prometheusError = $derived(prometheusSettingError(prometheus));
  const color = $derived(contextSettings(id).color);
  const pinned = $derived(isPinned(id));

  function save(change: Partial<ContextSettings>) {
    void updateContext(id, change);
  }

  const saveName = () => save({ display_name: name.trim() });
  const saveDefaultNs = () => !defaultNsError && save({ default_namespace: defaultNs.trim() });
  const saveAccessible = () => !accessibleError && save({ typed_namespaces: parseNamespaceList(accessible) });
  const savePrometheus = () => !prometheusError && save({ prometheus: prometheus.trim() });
  const saveShellCwd = () => save({ shell_cwd: shellCwd.trim() });

  function focus(node: HTMLElement) {
    node.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeClusterSettings();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeClusterSettings()} {onkeydown}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Cluster settings" data-testid="cluster-settings">
    <div class="head">
      <h2>{displayName({ name: id }, { display_name: name })}</h2>
      <button type="button" class="btn" use:focus onclick={closeClusterSettings}>Close</button>
    </div>
    {#if ctx}
      <p class="muted about mono" data-testid="cluster-about">
        Context {ctx.context} · {ctx.server || "no server"} · {ctx.file}
      </p>
    {/if}

    <fieldset>
      <legend>In kubeloupe</legend>
      <label class="row">
        <span>Display name</span>
        <input
          class="input"
          aria-label="Display name"
          placeholder={id}
          spellcheck="false"
          bind:value={name}
          onchange={saveName}
        />
      </label>
      <div class="row">
        <span>Colour</span>
        <div class="swatches" role="radiogroup" aria-label="Colour">
          {#each CLUSTER_COLORS as c (c)}
            <button
              type="button"
              role="radio"
              class="swatch"
              class:none={!c}
              aria-checked={color === c}
              aria-label={c ? `Colour ${c}` : "No colour"}
              style:background={c || "transparent"}
              onclick={() => save({ color: c })}
            ></button>
          {/each}
        </div>
      </div>
      <label class="choice">
        <input type="checkbox" checked={pinned} onchange={() => togglePin(id)} />
        Pinned (first in the context selector and the palette)
      </label>
    </fieldset>

    <fieldset>
      <legend>Namespaces</legend>
      <label class="row">
        <span>Default namespace</span>
        <input
          class="input"
          aria-label="Default namespace"
          placeholder="All namespaces if allowed"
          spellcheck="false"
          bind:value={defaultNs}
          onchange={saveDefaultNs}
        />
      </label>
      {#if defaultNsError}<p class="hint error-text">{defaultNsError}</p>{/if}
      <label class="row">
        <span>Accessible namespaces</span>
        <input
          class="input"
          aria-label="Accessible namespaces"
          placeholder="team-a, team-b"
          spellcheck="false"
          bind:value={accessible}
          onchange={saveAccessible}
        />
      </label>
      {#if accessibleError}<p class="hint error-text">{accessibleError}</p>{/if}
      <p class="muted hint">
        The default namespace is where the cluster opens when no namespaces are remembered. Accessible namespaces are
        offered in the namespace control when you may not list namespaces.
      </p>
    </fieldset>

    <fieldset>
      <legend>Metrics</legend>
      <label class="row">
        <span>Prometheus Service</span>
        <input
          class="input"
          aria-label="Prometheus Service"
          placeholder="Detect automatically"
          spellcheck="false"
          bind:value={prometheus}
          onchange={savePrometheus}
        />
      </label>
      {#if prometheusError}<p class="hint error-text">{prometheusError}</p>{/if}
    </fieldset>

    <fieldset>
      <legend>Local terminal</legend>
      <label class="row">
        <span>Working directory</span>
        <input
          class="input"
          aria-label="Working directory"
          placeholder="Home directory"
          spellcheck="false"
          bind:value={shellCwd}
          onchange={saveShellCwd}
        />
      </label>
      <p class="muted hint">Where new local terminals for this cluster start. ~ is your home directory.</p>
    </fieldset>
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
    width: min(560px, calc(100vw - 32px));
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
  .about {
    margin: 6px 0 0;
    font-size: 11px;
    word-break: break-all;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .swatches {
    display: flex;
    gap: 6px;
  }
  .swatch {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }
  .swatch.none {
    background: repeating-linear-gradient(45deg, transparent 0 4px, var(--border) 4px 5px) !important;
  }
  .swatch[aria-checked="true"] {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
