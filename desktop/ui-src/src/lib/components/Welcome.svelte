<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ContextInfo } from "../bindings";
  import { CATALOG_VIEW, displayName, orderContexts } from "../catalog";
  import { isMacPlatform } from "../keys";
  import { addedSources, lookedAt, nextSteps } from "../welcome";
  import { app, currentContextName, setStatus, setView, switchContext } from "../stores/app.svelte";
  import { catalog, loadSources } from "../stores/catalog.svelte";
  import { openHelpItem } from "../stores/help.svelte";
  import { contextSettings, settings } from "../stores/settings.svelte";
  import { leaveWelcome } from "../stores/welcome.svelte";
  import { isHidden } from "../stores/hidden.svelte";
  import Icon from "../icons/Icon.svelte";
  import AddSource from "./catalog/AddSource.svelte";
  import ExecPrompt from "./catalog/ExecPrompt.svelte";

  /**
   * The welcome screen (#485): on a first run, and whenever nauvi finds no
   * context at all. It says which kubeconfig files nauvi read and what they
   * held, lets the user pick a cluster (or add a kubeconfig), and shows the
   * first three things to do with their keys. Never a modal: the sidebar
   * and the header work as usual, and leaving it is remembered.
   */

  /** At most this many clusters here; the catalog lists them all. */
  const SHOWN = 8;

  const mac = isMacPlatform();
  const steps = nextSteps(mac);
  const looked = $derived(lookedAt(catalog.sources));
  const added = $derived(addedSources(catalog.sources));
  const none = $derived(app.contexts.length === 0);
  const contexts = $derived.by(() => {
    const visible = app.contexts.filter((c) => !isHidden(c.name));
    const { pinned, others } = orderContexts(visible, settings.current.favourites);
    return [...pinned, ...others].slice(0, SHOWN);
  });
  let busy = $state("");

  onMount(() => void loadSources());
  onDestroy(leaveWelcome);

  // With no kubeconfig there is no cluster to ask: the header says why.
  $effect(() => {
    if (none) setStatus(false, "No kubeconfig");
  });

  const nameOf = (c: ContextInfo) => displayName(c, contextSettings(c.name));

  async function pick(c: ContextInfo) {
    busy = c.name;
    if (c.name === currentContextName()) setView("overview");
    else await switchContext(c.name);
    busy = "";
  }
</script>

<div class="welcome" data-testid="welcome">
  <div class="column">
    <div class="intro">
      <p class="eyebrow">Welcome to nauvi</p>
      {#if none}
        <h2>No kubeconfig found</h2>
        <p class="lead">
          nauvi reads the same kubeconfig as <code>kubectl</code> and found none. Add one below, and nauvi
          shows its clusters at once.
        </p>
      {:else}
        <h2>Pick a cluster to start</h2>
        <p class="lead">
          nauvi reads the same kubeconfig as <code>kubectl</code>, and never changes it.
          It found {app.contexts.length === 1 ? "1 context" : `${app.contexts.length} contexts`}.
        </p>
      {/if}
    </div>

    <section class="card" aria-labelledby="welcome-looked">
      <h3 id="welcome-looked">Where nauvi looked</h3>
      <ul class="files" data-testid="welcome-looked">
        {#each looked as l (l.path)}
          <li>
            <span class="mark" class:ok={l.ok}><Icon name={l.ok ? "check" : "warning"} size={14} /></span>
            <code class="path" title={l.path}>{l.path}</code>
            <span class="found">{l.found}</span>
          </li>
        {:else}
          <li class="muted">Reading…</li>
        {/each}
        {#each added as s (s.path)}
          <li>
            <span class="mark" class:ok={!s.error}><Icon name={s.error ? "warning" : "check"} size={14} /></span>
            <code class="path" title={s.path}>{s.path}</code>
            <span class="found">{s.error || (s.contexts === 1 ? "1 context" : `${s.contexts} contexts`)} · added</span>
          </li>
        {/each}
      </ul>
      <p class="muted note">
        Set <code>KUBECONFIG</code> before starting nauvi to read other files, or add them in the
        <button type="button" class="link" onclick={() => setView(CATALOG_VIEW)}>cluster catalog</button>.
      </p>
    </section>

    {#if none}
      <section class="card" aria-labelledby="welcome-add">
        <h3 id="welcome-add">Add a kubeconfig</h3>
        <p class="muted note">A file or a folder of them, or paste one. nauvi only reads them.</p>
        <div class="add"><AddSource onclose={() => {}} cancel={false} /></div>
        <p class="muted note">
          Or let your cluster's tool write <code>~/.kube/config</code>, for example
          <code>kind create cluster</code>, <code>aws eks update-kubeconfig</code>,
          <code>gcloud container clusters get-credentials</code> or <code>az aks get-credentials</code>.
        </p>
        {#if catalog.prompt}
          <ExecPrompt source={catalog.prompt.source} commands={catalog.prompt.commands} />
        {/if}
        {#if catalog.error}
          <p class="error-text" role="alert">{catalog.error}</p>
        {/if}
      </section>
    {:else}
      <section class="card" aria-labelledby="welcome-pick">
        <h3 id="welcome-pick">Your clusters</h3>
        <ul class="clusters" data-testid="welcome-clusters">
          {#each contexts as c (c.name)}
            <li>
              <button type="button" class="cluster" disabled={!!busy} onclick={() => pick(c)}>
                <span class="name">{nameOf(c)}</span>
                <span class="server muted" title={c.server}>{c.server}</span>
                {#if c.current}<span class="tag">current</span>{/if}
                <span class="go">{busy === c.name ? "Opening…" : "Open"}<Icon name="arrowRight" size={14} /></span>
              </button>
            </li>
          {/each}
        </ul>
        {#if app.contexts.length > SHOWN}
          <button type="button" class="link more" onclick={() => setView(CATALOG_VIEW)}
            >All {app.contexts.length} clusters in the catalog</button
          >
        {/if}
      </section>
    {/if}

    <section aria-labelledby="welcome-next">
      <h3 id="welcome-next" class="steps-title">Next steps</h3>
      <ol class="steps">
        {#each steps as s, i (s.title)}
          <li class="card step">
            <span class="num">{i + 1}</span>
            <span class="what">{s.title}</span>
            <kbd>{s.keys}</kbd>
            <span class="muted how">{s.text}</span>
          </li>
        {/each}
      </ol>
    </section>

    <div class="foot">
      {#if !none}
        <button type="button" class="btn" onclick={() => setView("overview")}>Skip to the Overview</button>
      {/if}
      <button type="button" class="link" onclick={() => openHelpItem("get_started")}
        ><Icon name="external" size={14} />Getting started in the docs</button
      >
    </div>
  </div>
</div>

<style>
  .welcome {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .column {
    max-width: 760px;
    margin: 0 auto;
    padding: 36px 32px 40px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .intro .eyebrow {
    margin: 0;
    color: var(--accent);
  }
  h2 {
    margin: 4px 0 6px;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.01em;
  }
  .lead {
    margin: 0;
    max-width: 640px;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: 1.55;
  }
  code {
    font-family: var(--font-num);
    font-size: 0.92em;
  }
  .lead code {
    color: var(--text);
  }
  .card {
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
  h3 {
    margin: 0 0 8px;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 3px 0;
    font-size: var(--text-base);
  }
  .mark {
    display: inline-flex;
    color: var(--amber);
  }
  .mark.ok {
    color: var(--green);
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .found {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .note code {
    white-space: nowrap;
  }
  .foot .link {
    font-size: var(--text-sm);
  }
  .note {
    margin: 8px 0 0;
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .add {
    margin-top: 10px;
  }
  .clusters {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cluster {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background-color 140ms ease;
  }
  .cluster:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: var(--accent-soft);
  }
  .cluster:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .cluster:disabled {
    cursor: progress;
  }
  .name {
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
    white-space: nowrap;
  }
  .server {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-num);
    font-size: var(--text-sm);
  }
  .tag {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .go {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .steps-title {
    margin-top: 4px;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .step {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    column-gap: 8px;
    row-gap: 6px;
  }
  .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
  }
  .what {
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
  }
  kbd {
    font-family: var(--font-num);
    font-size: var(--text-sm);
    padding: 1px 7px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--bg);
    color: var(--text);
  }
  .how {
    grid-column: 1 / -1;
    font-size: var(--text-sm);
    line-height: 1.45;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 4px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .more {
    margin-top: 8px;
    font-size: var(--text-sm);
  }
  @media (max-width: 900px) {
    .steps {
      grid-template-columns: 1fr;
    }
  }
</style>
