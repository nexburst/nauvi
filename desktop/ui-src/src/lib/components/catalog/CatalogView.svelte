<script lang="ts">
  import { onMount } from "svelte";
  import type { ContextInfo, SourceInfo } from "../../bindings";
  import {
    checkedWhenAsked,
    displayName,
    filterContexts,
    lastUsedText,
    orderContexts,
    pathParts,
    rowMessage,
    SOURCE_LABELS,
    STATE_LABELS,
  } from "../../catalog";
  import { app, openContextWindow, switchContext } from "../../stores/app.svelte";
  import ModeBadge from "../ModeBadge.svelte";
  import {
    catalog,
    checkAll,
    checkOnDemand,
    checkOnOpen,
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
  import ExecPrompt from "./ExecPrompt.svelte";
  import ContextMenu from "../ContextMenu.svelte";
  import type { MenuItem } from "../ContextMenu.svelte";

  /** The cluster catalog (#78): every context from every kubeconfig source,
   *  with its status, pin, source file and last use. Opening it checks
   *  every cluster that logs in without running a plugin or sending local
   *  files from outside its added kubeconfig's folder; the others show a
   *  Check button (#201, #244). */
  let query = $state("");
  let adding = $state(false);
  /** The source a Remove is waiting to be confirmed for. */
  let removing = $state<SourceInfo | null>(null);
  const now = Date.now();
  /** The row's "More actions" menu (#179): where it opens and what it offers. */
  let menu = $state<{ x: number; y: number; title: string; items: MenuItem[]; context: string } | null>(null);

  onMount(() => {
    void loadSources();
    void checkOnOpen();
  });

  const nameOf = (c: ContextInfo) => displayName(c, contextSettings(c.name));
  /** Why a context's Check button is there: what checking it runs or sends. */
  function askTitle(c: ContextInfo): string {
    if (c.login_command) return `Logs in by running ${c.login_command}`;
    if (c.login_plugin) return "Logs in through an auth provider";
    return `Logging in sends ${c.local_files.join(", ")}`;
  }
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

  /** Open (or close) the row's menu below its "More" button. */
  function showMenu(e: MouseEvent, c: ContextInfo, name: string) {
    if (menu?.context === c.name) {
      menu = null;
      return;
    }
    const trigger = e.currentTarget as HTMLElement;
    // WebKit on macOS does not focus a clicked button; focus it so the menu
    // gives focus back to it when it closes.
    trigger.focus({ preventScroll: true });
    const r = trigger.getBoundingClientRect();
    const source = c.source;
    const items: MenuItem[] = [
      { label: "Open in new window", run: () => void openContextWindow(c.name) },
      {
        label: "Check connection",
        disabled: catalog.checks.get(c.name) === "checking",
        run: () => void checkOnDemand(c.name),
      },
      { label: "Settings…", run: () => openClusterSettings(c.name) },
    ];
    if (source) items.push({ label: "Remove source…", danger: true, run: () => askRemove(source) });
    menu = { x: r.left, y: r.bottom + 2, title: name, items, context: c.name };
  }
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
  {#if catalog.prompt}
    <ExecPrompt source={catalog.prompt.source} commands={catalog.prompt.commands} />
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
          ? "The pasted kubeconfig saved by nauvi is deleted."
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
    <!-- Fixed columns (#179): long text is cut or wrapped inside its column
         instead of pushing the actions out of the window. -->
    <table aria-label="Clusters">
      <colgroup>
        <col class="c-pin" />
        <col class="c-name" />
        <col class="c-status" />
        <col class="c-server" />
        <col class="c-source" />
        <col class="c-used" />
        <col class="c-actions" />
      </colgroup>
      <thead>
        <tr>
          <th><span class="hidden">Pinned</span></th>
          <th>Name</th>
          <th>Status</th>
          <th>Server · user</th>
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
                <span class="label" data-testid="catalog-name">{name}</span>
              </div>
              {#if c.current || (cs.mode ?? "normal") !== "normal"}
                <div class="under">
                  {#if c.current}<span class="badge">this window</span>{/if}
                  <ModeBadge mode={cs.mode} name={c.context} />
                </div>
              {/if}
              {#if name !== c.name}<div class="muted id">{c.name}</div>{/if}
            </td>
            <td class="status" data-testid="catalog-status">
              {#if check === "checking"}
                <span class="muted">Checking…</span>
              {:else if check && check.state !== "local_files"}
                <span
                  class:ok={check.state === "connected"}
                  class:bad={check.state !== "connected"}
                  title={check.message || check.version}>{STATE_LABELS[check.state]}</span
                >
                {#if check.state !== "connected"}
                  <div class="why muted" data-testid="catalog-status-message" title={check.message}>
                    {rowMessage(check.message, c.name)}
                  </div>
                {/if}
                {#if check.state === "not_allowed"}
                  <button type="button" class="btn small" aria-label="Check {name}" onclick={() => void checkOnDemand(c.name)}
                    >Check</button
                  >
                {/if}
              {:else if checkedWhenAsked(c) || check}
                <!-- Checking runs the login plugin or sends local files: only when asked (#201, #244). -->
                <button
                  type="button"
                  class="btn small"
                  aria-label="Check {name}"
                  title={askTitle(c)}
                  onclick={() => void checkOnDemand(c.name)}>Check</button
                >
              {:else}
                <span class="muted">Not checked</span>
              {/if}
              {#if c.local_files.length}
                <div class="why muted files" data-testid="catalog-local-files" title={`Logging in sends ${c.local_files.join(", ")}`}>
                  Sends local files: {c.local_files.join(", ")}
                </div>
              {:else if check && check !== "checking" && check.state === "local_files"}
                <div class="why muted" data-testid="catalog-status-message" title={check.message}>{check.message}</div>
              {/if}
            </td>
            <td class="mono">
              <div class="clip" data-testid="catalog-server" title={c.server || undefined}>{c.server || "—"}</div>
              <div class="clip muted user" data-testid="catalog-user" title={c.user || undefined}>{c.user || "—"}</div>
            </td>
            <td class="mono" data-testid="catalog-file" title={c.file}>
              <!-- Wraps between folders only (#179). -->
              <div class="source">
                {#each pathParts(c.file) as part, i (i)}<span class="part">{part}</span><wbr />{/each}
              </div>
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
                  class="btn more"
                  aria-label="More actions for {name}"
                  title="New window, check, settings, remove"
                  aria-haspopup="menu"
                  aria-expanded={menu?.context === c.name}
                  onclick={(e) => showMenu(e, c, name)}>⋯</button
                >
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if menu}
    <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onclose={() => (menu = null)} />
  {/if}

  <h3>Kubeconfig sources</h3>
  <p class="muted note">
    nauvi reads these files and never changes them. Files and folders are checked for changes every few seconds.
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
    table-layout: fixed;
    min-width: 860px;
  }
  .c-pin {
    width: 32px;
  }
  .c-name {
    width: 16%;
  }
  .c-status {
    width: 18%;
  }
  .c-server {
    width: 20%;
  }
  .c-source {
    width: 22%;
  }
  .c-used {
    width: 10%;
  }
  .c-actions {
    width: 108px;
  }
  td {
    vertical-align: top;
    overflow: hidden;
  }
  th {
    overflow: hidden;
    text-overflow: ellipsis;
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
  /* The swatch and the name stay on one line; a long name wraps beside it. */
  .name {
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: normal;
  }
  .name .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .under {
    margin: 2px 0 0 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
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
  /* Two lines at most; the full message is in the tooltip (#179). */
  .why {
    white-space: normal;
    overflow-wrap: break-word;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  /* The files are the point of this line: shown whole (#244). */
  .why.files {
    display: block;
    overflow-wrap: anywhere;
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
  /* One line, cut with an ellipsis; the full text is in the tooltip (#179). */
  .clip {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .user {
    font-size: 11px;
    margin-top: 2px;
  }
  /* Breaks after each folder (<wbr>), not inside a name that fits. */
  .source {
    white-space: normal;
  }
  /* Each folder is a box of its own: the path breaks between them, and a
     single folder name breaks inside only if it is wider than the column. */
  .source .part {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
  }
  .more {
    padding-inline: 8px;
  }
  .btn.small {
    font-size: 12px;
    padding: 1px 8px;
    margin-top: 2px;
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
