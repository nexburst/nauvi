<script lang="ts">
  import { onMount } from "svelte";
  import type { ContextInfo, SourceInfo } from "../../bindings";
  import { displayName, filterContexts, lastUsedText, orderContexts, SOURCE_LABELS, STATE_LABELS } from "../../catalog";
  import { app, openContextWindow, switchContext } from "../../stores/app.svelte";
  import {
    catalog,
    checkAll,
    checkContext,
    isPinned,
    loadSources,
    openClusterSettings,
    removeSource,
    togglePin,
  } from "../../stores/catalog.svelte";
  import { live } from "../../stores/live.svelte";
  import { contextSettings, settings } from "../../stores/settings.svelte";
  import { confirmDiscard } from "../../stores/unsaved.svelte";
  import AddSource from "./AddSource.svelte";

  /** The cluster catalog (#78): every context from every kubeconfig source,
   *  with its status, pin, source file and last use. Opening it checks
   *  every cluster. */
  let query = $state("");
  let adding = $state(false);
  /** The source a Remove is waiting to be confirmed for. */
  let removing = $state<SourceInfo | null>(null);
  const now = Date.now();

  onMount(() => {
    void loadSources();
    void checkAll();
  });

  const nameOf = (c: ContextInfo) => displayName(c, contextSettings(c.name));
  const rows = $derived.by(() => {
    void settings.current;
    const { pinned, others } = orderContexts(app.contexts, settings.current.favourites);
    return filterContexts([...pinned, ...others], query, nameOf);
  });

  $effect(() => {
    const n = app.contexts.length;
    app.count = n === 1 ? "1 cluster" : `${n} clusters`;
  });

  async function open(id: string) {
    if (!(await confirmDiscard())) return;
    live.stop();
    await switchContext(id);
  }

  function askRemove(path: string) {
    removing = catalog.sources.find((s) => s.path === path) ?? null;
  }

  async function confirmRemove() {
    const source = removing;
    removing = null;
    if (source) await removeSource(source.path);
  }

  const removable = (s: SourceInfo) => s.kind !== "kubeconfig";
</script>

<div class="catalog" data-testid="catalog">
  <div class="head">
    <h2>Clusters</h2>
    <input
      class="input filter"
      type="search"
      aria-label="Filter clusters"
      placeholder="Filter by name, server or file"
      bind:value={query}
    />
    <button type="button" class="btn" onclick={() => void checkAll()}>Check all</button>
    <button type="button" class="btn primary" aria-expanded={adding} onclick={() => (adding = !adding)}
      >Add kubeconfig…</button
    >
  </div>

  {#if adding}
    <AddSource onclose={() => (adding = false)} />
  {/if}
  {#if catalog.error}
    <p class="error-text message" role="alert" data-testid="catalog-error">{catalog.error}</p>
  {/if}
  {#if removing}
    <div class="confirm" role="alertdialog" aria-label="Remove source" data-testid="confirm-remove">
      <span>
        Remove {removing.path}? Its {removing.contexts === 1 ? "context leaves" : `${removing.contexts} contexts leave`}
        the catalog.
        {removing.kind === "pasted"
          ? "The pasted kubeconfig saved by kubeloupe is deleted."
          : "The file itself is not changed."}
      </span>
      <button type="button" class="btn primary" onclick={confirmRemove}>Remove</button>
      <button type="button" class="btn" onclick={() => (removing = null)}>Cancel</button>
    </div>
  {/if}

  {#if app.contexts.length === 0}
    <p class="muted empty">
      No contexts yet. Add a kubeconfig file or folder, or paste a kubeconfig, to connect to a cluster.
    </p>
  {:else}
    <table aria-label="Clusters">
      <thead>
        <tr>
          <th><span class="hidden">Pinned</span></th>
          <th>Name</th>
          <th>Status</th>
          <th>Server</th>
          <th>User</th>
          <th>Source</th>
          <th>Last used</th>
          <th><span class="hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as c (c.name)}
          {@const cs = contextSettings(c.name)}
          {@const check = catalog.checks.get(c.name)}
          {@const pinned = isPinned(c.name)}
          {@const name = nameOf(c)}
          <tr data-testid="catalog-row" data-context={c.name} class:current={c.current}>
            <td>
              <button
                type="button"
                class="pin"
                class:on={pinned}
                aria-pressed={pinned}
                aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
                title={pinned ? "Unpin" : "Pin to the top of the context selector and the palette"}
                onclick={() => togglePin(c.name)}>★</button
              >
            </td>
            <td>
              <div class="name">
                <span class="swatch" style:background={cs.color || "transparent"} aria-hidden="true"></span>
                <span data-testid="catalog-name">{name}</span>
                {#if c.current}<span class="badge">this window</span>{/if}
              </div>
              {#if name !== c.name}<div class="muted id">{c.name}</div>{/if}
            </td>
            <td class="status" data-testid="catalog-status">
              {#if check === "checking"}
                <span class="muted">Checking…</span>
              {:else if check}
                <span
                  class:ok={check.state === "connected"}
                  class:bad={check.state !== "connected"}
                  title={check.message || check.version}>{STATE_LABELS[check.state]}</span
                >
                {#if check.state !== "connected"}
                  <div class="why muted" data-testid="catalog-status-message">{check.message}</div>
                {/if}
              {:else}
                <span class="muted">Not checked</span>
              {/if}
            </td>
            <td class="mono wrap">{c.server || "—"}</td>
            <td class="mono">{c.user || "—"}</td>
            <td class="mono source" title={c.file}>
              {c.file}
              {#if c.source}
                <div class="muted kind">
                  {SOURCE_LABELS[catalog.sources.find((s) => s.path === c.source)?.kind ?? "file"]}
                </div>
              {/if}
            </td>
            <td class="muted">{lastUsedText(cs.last_used, now)}</td>
            <td>
              <div class="actions">
                <button type="button" class="btn" disabled={c.current} aria-label="Open {name}" onclick={() => open(c.name)}
                  >Open</button
                >
                <button
                  type="button"
                  class="btn"
                  aria-label="Open {name} in new window"
                  onclick={() => openContextWindow(c.name)}>New window</button
                >
                <button
                  type="button"
                  class="btn"
                  aria-label="Check {name}"
                  disabled={check === "checking"}
                  onclick={() => checkContext(c.name)}>Check</button
                >
                <button
                  type="button"
                  class="btn"
                  aria-label="Settings for {name}"
                  onclick={() => openClusterSettings(c.name)}>Settings</button
                >
                {#if c.source}
                  <button type="button" class="btn" aria-label="Remove {name}'s source" onclick={() => askRemove(c.source)}
                    >Remove</button
                  >
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <h3>Kubeconfig sources</h3>
  <p class="muted note">
    kubeloupe reads these files and never changes them. Files and folders are checked for changes every few seconds.
  </p>
  <ul class="sources" aria-label="Kubeconfig sources">
    {#each catalog.sources as s (s.path)}
      <li data-testid="catalog-source">
        <span class="badge">{SOURCE_LABELS[s.kind]}</span>
        <span class="mono path">{s.path}</span>
        {#if s.error}
          <span class="error-text">{s.error}</span>
        {:else}
          <span class="muted"
            >{s.contexts === 1 ? "1 context" : `${s.contexts} contexts`}{s.kind === "folder"
              ? ` in ${s.files === 1 ? "1 file" : `${s.files} files`}`
              : ""}</span
          >
        {/if}
        {#if removable(s)}
          <button type="button" class="btn" aria-label="Remove source {s.path}" onclick={() => askRemove(s.path)}
            >Remove</button
          >
        {/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .catalog {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  h2 {
    margin: 0 auto 0 0;
    font-size: 15px;
  }
  h3 {
    margin: 24px 0 4px;
    font-size: 13px;
  }
  .filter {
    width: 260px;
  }
  .message,
  .note,
  .empty {
    font-size: 13px;
    margin: 0 0 12px;
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 8px 10px;
    margin-bottom: 12px;
    border: 1px solid var(--amber);
    border-radius: 6px;
  }
  .confirm span {
    flex: 1;
  }
  table {
    font-size: 13px;
  }
  td {
    vertical-align: top;
  }
  tr.current {
    background: var(--bg-hover);
  }
  .pin {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 15px;
    color: var(--text-muted);
    opacity: 0.4;
    padding: 0;
  }
  .pin.on {
    color: var(--amber);
    opacity: 1;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .id,
  .kind,
  .why {
    font-size: 11px;
  }
  .why {
    white-space: normal;
    max-width: 280px;
  }
  .badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
    color: var(--text-muted);
  }
  .status .ok {
    color: var(--green);
  }
  .status .bad {
    color: var(--red);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .wrap,
  .source {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .wrap {
    max-width: 200px;
  }
  .source {
    max-width: 260px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 230px;
  }
  .sources {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
  }
  .sources li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .sources .path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
