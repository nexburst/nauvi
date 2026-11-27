<script lang="ts">
  import type { ContainerDetail } from "../bindings";
  import AvailableTags from "./AvailableTags.svelte";
  import ContainerEnvList from "./ContainerEnvList.svelte";
  import { settings } from "../stores/settings.svelte";
  import { envTitle } from "../podEnv";
  import {
    envSourceText,
    envSummary,
    mountText,
    quantitiesText,
    shellJoin,
    stateSince,
    stateText,
    stateTone,
  } from "../containers";

  /** One container of the pod panel: state, then a key/value summary (image,
   *  command, args, requests, limits, env count, mounts with their source),
   *  then ports (each with a Forward button), probes and the full mount and
   *  env lists. Command and args arrive masked from the backend. */
  let {
    container: c,
    onForward,
    disabled = false,
    pod,
  }: {
    container: ContainerDetail;
    onForward: (port: number) => void;
    disabled?: boolean;
    /** The pod, to load env values from (#447); without it only names. */
    pod?: { namespace: string; name: string };
  } = $props();

  /** Longer than this, a command or args line starts folded to one line. */
  const LONG = 72;
  /** Mounts listed in the summary; the rest are in the folded list. */
  const SHOWN_MOUNTS = 3;

  const command = $derived(shellJoin(c.command));
  const args = $derived(shellJoin(c.args));
  const hasResources = $derived(Object.keys(c.requests).length + Object.keys(c.limits).length > 0);
  let open = $state<Record<string, boolean>>({});
  /** The Environment list is open: its values are loaded (and dropped
   *  again when it closes). */
  let envOpen = $state(false);
  /** The number of variables, once the list has loaded them (#525). */
  let envLoaded = $state<number | null>(null);
</script>

{#snippet longValue(key: string, text: string)}
  {@const long = text.length > LONG}
  <dd class="mono long" data-testid="container-{key}">
    <span class="value" class:folded={long && !open[key]} title={long ? text : undefined}>{text}</span>
    {#if long}
      <button
        type="button"
        class="link"
        aria-expanded={!!open[key]}
        aria-label="{open[key] ? 'Fold' : 'Show all of'} {key}"
        onclick={() => (open[key] = !open[key])}>{open[key] ? "less" : "more"}</button
      >
    {/if}
  </dd>
{/snippet}

<section class="card" aria-label="Container {c.name}">
  <div class="head">
    <span class="name">{c.name}</span>
    {#if c.kind !== "regular"}<span class="tag">{c.kind}</span>{/if}
    <span class="ready" class:ok={c.ready}>{c.ready ? "ready" : "not ready"}</span>
  </div>

  <div class="state tone-{stateTone(c.state)}" data-testid="container-state">
    {stateText(c.state)}
    {#if stateSince(c.state)}<span class="muted"> · {stateSince(c.state)}</span>{/if}
  </div>
  {#if c.state.message}<div class="message">{c.state.message}</div>{/if}

  <dl class="summary" data-testid="container-summary">
    <dt>Image</dt>
    <dd class="mono image" title={c.image_id ? `${c.image}\n${c.image_id}` : c.image}>{c.image}</dd>
    {#if settings.current.registry_tags}
      <dd class="tags-row"><AvailableTags image={c.image} imageId={c.image_id} label={c.name} /></dd>
    {/if}
    {#if c.command.length > 0}
      <dt>Command</dt>
      {@render longValue("command", command)}
    {/if}
    {#if c.args.length > 0}
      <dt>Args</dt>
      {@render longValue("args", args)}
    {/if}
    {#if c.secrets_hidden}
      <dd class="note muted" data-testid="secrets-hidden">Values that look like secrets are hidden (••••).</dd>
    {/if}
    {#if hasResources}
      <dt>Requests</dt>
      <dd>{quantitiesText(c.requests)}</dd>
      <dt>Limits</dt>
      <dd>{quantitiesText(c.limits)}</dd>
    {/if}
    {#if c.env.length > 0}
      <dt>Env</dt>
      <dd data-testid="container-env">{envSummary(c.env)}</dd>
    {/if}
    {#if c.mounts.length > 0}
      <dt>Mounts</dt>
      <dd data-testid="container-mounts">
        {#each c.mounts.slice(0, SHOWN_MOUNTS) as m (m.path)}
          <div class="mono mount" title="volume {m.name}">{mountText(m)}</div>
        {/each}
        {#if c.mounts.length > SHOWN_MOUNTS}
          <div class="muted">+{c.mounts.length - SHOWN_MOUNTS} more below</div>
        {/if}
      </dd>
    {/if}
    <dt>Restarts</dt>
    <dd>{c.restarts}</dd>
    {#if c.last_state.state}
      <dt>Last state</dt>
      <dd class="tone-{stateTone(c.last_state)}" data-testid="last-state">
        {stateText(c.last_state)}
        {#if stateSince(c.last_state)}<span class="muted"> · {stateSince(c.last_state)}</span>{/if}
      </dd>
    {/if}
  </dl>

  {#if c.ports.length > 0}
    <h4>Ports</h4>
    <ul>
      {#each c.ports as p (p.port + p.protocol)}
        <li>
          <span class="mono">{p.port}/{p.protocol}</span>
          {#if p.name}<span class="muted">{p.name}</span>{/if}
          {#if p.protocol === "TCP"}
            <button
              type="button"
              class="btn small"
              {disabled}
              aria-label="Forward port {p.port}"
              onclick={() => onForward(p.port)}>Forward</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if c.probes.length > 0}
    <h4>Probes</h4>
    <ul>
      {#each c.probes as p (p.kind)}
        <li><span class="muted">{p.kind}</span> <span class="mono">{p.summary}</span></li>
      {/each}
    </ul>
  {/if}

  {#if c.mounts.length > 0}
    <details>
      <summary>Mounts ({c.mounts.length})</summary>
      <ul>
        {#each c.mounts as m (m.path)}
          <li>
            <span class="mono">{m.path}</span>
            <span class="muted"
              >from {m.name}{m.sub_path ? `/${m.sub_path}` : ""}{m.source ? ` · ${m.source}` : ""}{m.read_only
                ? " (ro)"
                : ""}</span
            >
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if c.env.length > 0}
    <details ontoggle={(e) => (envOpen = (e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{envTitle(c.env, envLoaded)}</summary>
      {#if pod}
        {#if envOpen}
          <ContainerEnvList
            namespace={pod.namespace}
            pod={pod.name}
            container={c.name}
            names={c.env}
            onCount={(n) => (envLoaded = n)}
          />
        {/if}
      {:else}
        <ul>
          {#each c.env as e, i (i)}
            <li><span class="mono">{e.name}</span> <span class="muted">{envSourceText(e.source)}</span></li>
          {/each}
        </ul>
      {/if}
    </details>
  {/if}
</section>

<style>
  .card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .tag {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
    color: var(--text-muted);
  }
  .ready {
    margin-left: auto;
    color: var(--amber);
  }
  .ready.ok {
    color: var(--green);
  }
  /* One token: on one line, cut, the whole image in the title (#384). */
  .image {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    font-weight: 600;
    margin-top: 2px;
  }
  dd.long {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
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
  .tags-row {
    grid-column: 2;
  }
  .note {
    grid-column: 2;
    font-size: 11px;
  }
  .mount {
    overflow-wrap: anywhere;
  }
  .mount + .mount {
    margin-top: 2px;
  }
  .link {
    flex: none;
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
  .message {
    margin-top: 2px;
    word-break: break-word;
    color: var(--text-muted);
  }
  .tone-ok {
    color: var(--green);
  }
  .tone-warn {
    color: var(--amber);
  }
  .tone-bad {
    color: var(--red);
  }
  dl {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 2px 10px;
    margin: 6px 0 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  h4 {
    margin: 8px 0 2px;
    font-size: 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: 1px 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 6px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .btn.small {
    padding: 1px 8px;
    font-size: 11px;
  }
</style>
