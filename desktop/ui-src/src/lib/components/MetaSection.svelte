<script lang="ts">
  import type { Snippet } from "svelte";
  import type { OwnerLink, ResourceDetail } from "../bindings";
  import { kindOf, openObject } from "../stores/app.svelte";
  import { settings } from "../stores/settings.svelte";
  import { dateTime } from "../timeZone";
  import { ageRedrawMs, formatAge } from "../format";
  import { onAgeTick } from "../ageClock";
  import { onDestroy } from "svelte";
  import { LAST_APPLIED } from "../lastApplied";
  import LastApplied from "./LastApplied.svelte";

  /** Identity, owners, labels, annotations and finalizers of any object.
   *  `children` adds rows to the identity list (the pod panel's phase, node...). */
  let { info, children }: { info: ResourceDetail; children?: Snippet } = $props();

  /** The kind an owner reference points at, if discovery knows it. */
  function ownerKind(o: OwnerLink) {
    return kindOf(o.api_version, o.kind);
  }

  // The age ticks like the table's (#380): every second while it shows seconds.
  let now = $state.raw(Date.now());
  onDestroy(
    onAgeTick((t) => {
      if (t - now >= ageRedrawMs(info.created, t) - 50) now = t;
    }),
  );

  function openOwner(o: OwnerLink) {
    const kind = ownerKind(o);
    if (!kind) return;
    // Owners live in the object's namespace, or are cluster scoped.
    openObject(kind, kind.resource.namespaced ? info.namespace : "", o.name);
  }
</script>

<dl class="meta">
  <dt>Kind</dt>
  <dd>{info.kind} <span class="muted">({info.api_version})</span></dd>
  <dt>Name</dt>
  <dd class="token" title={info.name}>{info.name}</dd>
  {#if info.namespace}
    <dt>Namespace</dt>
    <dd class="token" title={info.namespace}>{info.namespace}</dd>
  {/if}
  <dt>Age</dt>
  <dd data-testid="meta-age">
    {formatAge(info.created, now, info.age) || "—"}
    {#if info.created > 0}
      <span class="muted" data-testid="meta-created">({dateTime(info.created * 1000, settings.current.time_zone)})</span>
    {/if}
  </dd>
  {@render children?.()}
  <dt>UID</dt>
  <dd class="mono token" title={info.uid}>{info.uid}</dd>
</dl>

{#if info.owners.length > 0}
  <h3>Owned by</h3>
  <ul class="plain">
    {#each info.owners as o (o.kind + "/" + o.name)}
      <li>
        {#if ownerKind(o)}
          <button type="button" class="link" onclick={() => openOwner(o)}>
            {o.kind}/{o.name}
          </button>
        {:else}
          {o.kind}/{o.name}
        {/if}
        {#if o.controller}<span class="muted"> (controller)</span>{/if}
      </li>
    {/each}
  </ul>
{/if}

{#if Object.keys(info.labels).length > 0}
  <h3>Labels</h3>
  <div class="chips">
    {#each Object.entries(info.labels) as [k, v] (k)}
      <span class="chip">{k}={v}</span>
    {/each}
  </div>
{/if}

{#if Object.keys(info.annotations).length > 0}
  <details>
    <summary>Annotations ({Object.keys(info.annotations).length})</summary>
    <dl class="annotations">
      {#each Object.entries(info.annotations) as [k, v] (k)}
        <dt>{k}</dt>
        {#if k === LAST_APPLIED}
          <dd class="full"><LastApplied value={v} /></dd>
        {:else}
          <dd class="mono">{v}</dd>
        {/if}
      {/each}
    </dl>
  </details>
{/if}

{#if info.finalizers.length > 0}
  <h3>Finalizers</h3>
  <div class="chips">
    {#each info.finalizers as f (f)}<span class="chip">{f}</span>{/each}
  </div>
{/if}

<style>
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
  dl.meta {
    display: grid;
    /* minmax(0, …): a long value is cut or wrapped, never widens the panel. */
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  dl.meta :global(dt) {
    color: var(--text-muted);
  }
  /* Prose (a message, the kind) wraps between words; a word longer than
     the line breaks only as a last resort (#384). */
  dl.meta :global(dd) {
    margin: 0;
    overflow-wrap: break-word;
  }
  /* One token (a name, an IP, a UID): on one line, cut with an ellipsis. The
     whole value is in its title, and selecting it copies all of it. */
  dl.meta :global(dd.token) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  ul.plain {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
  }
  ul.plain li {
    padding: 2px 0;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 12px;
    font-size: 13px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  dl.annotations {
    margin: 8px 0 0;
    font-size: 12px;
  }
  dl.annotations dt {
    color: var(--text-muted);
    margin-top: 6px;
    overflow-wrap: anywhere;
  }
  dl.annotations dd {
    margin: 0;
    overflow-wrap: anywhere;
    max-height: 6em;
    overflow: auto;
  }
  dl.annotations dd.full {
    max-height: none;
    overflow: visible;
  }
</style>
