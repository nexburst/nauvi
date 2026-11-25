<script lang="ts">
  import { onMount } from "svelte";
  import { api, visibleCluster } from "../cluster";
  import type { ContainerEnv, EnvInfo, EnvValue } from "../bindings";
  import { envSourceText } from "../containers";
  import { envGroupTitle, envRowId, envShownValue, envValueSource, LONG_VALUE, SECRET_REF } from "../podEnv";

  /** A container's environment with its values (#447), loaded when the
   *  Environment list is opened (this component is mounted only then).
   *  Secret values and secret-looking literals arrive hidden; each is read
   *  on an explicit Reveal, one at a time, and lives only in this
   *  component: closing the list or the panel drops them. */
  let {
    namespace,
    pod,
    container,
    names,
  }: { namespace: string; pod: string; container: string; names: EnvInfo[] } = $props();

  let env = $state.raw<ContainerEnv | null>(null);
  let loadError = $state("");
  let loading = $state(false);
  /** Revealed values by row id. */
  let revealed = $state.raw(new Map<string, string>());
  /** Rows whose long value is unfolded. */
  let unfolded = $state.raw(new Set<string>());
  let rowError = $state.raw(new Map<string, string>());
  let status = $state("");

  async function load() {
    loading = true;
    loadError = "";
    try {
      env = await api(visibleCluster()).cmdPodEnv(namespace, pod, container);
      revealed = new Map();
      rowError = new Map();
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function valueOf(r: EnvValue): Promise<string> {
    if (r.kind === "secret") {
      const v = await api(visibleCluster()).cmdRevealDataValue(SECRET_REF, namespace, r.object, r.key);
      return v.binary ? `${v.value} (base64)` : v.value;
    }
    return await api(visibleCluster()).cmdRevealPodEnv(namespace, pod, container, r.name);
  }

  function setRowError(id: string, text: string) {
    const next = new Map(rowError);
    if (text) next.set(id, text);
    else next.delete(id);
    rowError = next;
  }

  async function reveal(id: string, r: EnvValue) {
    status = "";
    try {
      const v = await valueOf(r);
      revealed = new Map(revealed).set(id, v);
      setRowError(id, "");
    } catch (e) {
      setRowError(id, `Could not read ${r.name}: ${e}`);
    }
  }

  function hide(id: string) {
    const next = new Map(revealed);
    next.delete(id);
    revealed = next;
  }

  async function copy(id: string, r: EnvValue) {
    status = "";
    const text = revealed.get(id) ?? (r.hidden ? null : r.value);
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      status = `Copied the value of ${r.name}.`;
    } catch {
      status = "Could not copy to the clipboard.";
    }
  }

  function toggleFold(id: string) {
    const next = new Set(unfolded);
    if (!next.delete(id)) next.add(id);
    unfolded = next;
  }
</script>

{#snippet valueRow(id: string, r: EnvValue)}
  {@const shown = revealed.get(id)}
  {@const text = shown ?? envShownValue(r)}
  {@const long = text.length > LONG_VALUE}
  {@const source = envValueSource(r)}
  <li class="row" class:overridden={r.overridden} data-testid="env-row" data-name={r.name}>
    <span class="mono name" title={r.overridden ? "Overridden by a later variable of the same name" : undefined}
      >{r.name}</span
    >
    {#if r.error}
      <span class="error-text err" data-testid="env-error">{r.error}</span>
    {:else}
      <span
        class="mono value"
        class:masked={r.hidden && shown === undefined}
        class:ref={!r.hidden && (r.kind === "resource" || (r.kind === "field" && !r.value))}
        class:folded={long && !unfolded.has(id)}
        title={long && shown === undefined ? text : undefined}
        data-testid="env-value">{text}</span
      >
      <span class="actions">
        {#if long}
          <button type="button" class="link" aria-label="{unfolded.has(id) ? 'Fold' : 'Show all of'} {r.name}" onclick={() => toggleFold(id)}
            >{unfolded.has(id) ? "less" : "more"}</button
          >
        {/if}
        {#if r.hidden}
          {#if shown === undefined}
            <button type="button" class="link" aria-label="Reveal {r.name}" title="Reveal this value" onclick={() => reveal(id, r)}
              >Reveal</button
            >
          {:else}
            <button type="button" class="link" aria-label="Hide {r.name}" onclick={() => hide(id)}>Hide</button>
          {/if}
        {/if}
        {#if (!r.hidden || shown !== undefined) && r.kind !== "resource" && text}
          <button type="button" class="link" aria-label="Copy {r.name}" onclick={() => copy(id, r)}>Copy</button>
        {/if}
      </span>
    {/if}
    {#if source}<span class="muted src">from {source}</span>{/if}
    {#if r.overridden}<span class="muted src">(overridden)</span>{/if}
    {#if rowError.get(id)}<span class="error-text err" data-testid="env-reveal-error">{rowError.get(id)}</span>{/if}
  </li>
{/snippet}

<div class="env" data-testid="env-list">
  {#if loading && !env}
    <p class="muted">Loading values…</p>
  {:else if loadError && !env}
    <p class="error-text" data-testid="env-load-error">Could not load the values: {loadError}</p>
    <ul>
      {#each names as e, i (i)}
        <li><span class="mono">{e.name}</span> <span class="muted">{envSourceText(e.source)}</span></li>
      {/each}
    </ul>
    <button type="button" class="link" onclick={load}>Try again</button>
  {:else if env}
    {#each env.from as g, gi (gi)}
      <div class="group" data-testid="env-group">
        <div class="group-title muted">{envGroupTitle(g)}</div>
        {#if g.error}
          <p class="error-text err" data-testid="env-error">{g.error}</p>
        {:else if g.rows.length === 0}
          <p class="muted">No keys.</p>
        {:else}
          <ul>
            {#each g.rows as r, i (i)}
              {@render valueRow(envRowId(gi, i), r)}
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
    {#if env.env.length > 0}
      <ul>
        {#each env.env as r, i (i)}
          {@render valueRow(envRowId("env", i), r)}
        {/each}
      </ul>
    {/if}
    <div class="foot">
      {#if status}<span class="muted" role="status">{status}</span>{/if}
      <button type="button" class="link" disabled={loading} onclick={load}>Reload</button>
    </div>
  {/if}
</div>

<style>
  .env {
    margin-top: 4px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(80px, max-content) minmax(0, 1fr) auto;
    column-gap: 8px;
    align-items: baseline;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child {
    border-bottom: none;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .overridden .name,
  .overridden .value {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .value {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .value.folded {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .value.masked,
  .value.ref {
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .src,
  .err {
    grid-column: 2 / -1;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .row > .err:nth-child(2) {
    grid-column: 2 / -1;
    font-size: 12px;
  }
  .group {
    margin: 4px 0 6px;
    padding-left: 6px;
    border-left: 2px solid var(--border);
  }
  .group-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .group p {
    margin: 2px 0;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
