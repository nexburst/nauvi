<script lang="ts">
  import { untrack } from "svelte";
  import type { ContextInfo } from "../bindings";
  import { groupContexts, sectionsOf, stateText } from "../clusterTree";
  import { app, currentContextName, openContextWindow } from "../stores/app.svelte";
  import { contextLabel } from "../stores/catalog.svelte";
  import { contextSettings } from "../stores/settings.svelte";
  import {
    answerNode,
    connectNode,
    disconnectNode,
    isExpanded,
    nodeOf,
    showNode,
    toggleGroup,
    toggleNode,
    tree,
    visibleChanged,
  } from "../stores/clusters.svelte";
  import { clusterStates } from "../stores/clusterStates.svelte";
  import ExecPrompt from "./catalog/ExecPrompt.svelte";
  import SidebarKinds from "./SidebarKinds.svelte";

  // Every kubeconfig context, by source (ADR 0007). Nothing is asked of a
  // cluster until its node is expanded or selected.
  const groups = $derived(groupContexts(app.contexts));
  const visible = $derived(currentContextName());

  // A switch from elsewhere (header, catalog, palette, link): the cluster
  // shown before stays connected.
  let shown = "";
  $effect(() => {
    const id = visible;
    untrack(() => {
      visibleChanged(shown, id);
      shown = id;
    });
  });

  // A background cluster connected from elsewhere has no kinds listed yet.
  $effect(() => {
    for (const id of tree.expanded) {
      const n = nodeOf(id);
      if (id !== visible && n.state === "connected" && !n.kinds) untrack(() => void connectNode(id));
    }
  });

  const label = (id: string) => contextLabel(id);
  const colorOf = (id: string) => contextSettings(id).color;
</script>

{#snippet node(ctx: ContextInfo)}
  {@const id = ctx.name}
  {@const n = nodeOf(id)}
  {@const isVisible = id === visible}
  {@const open = isExpanded(id)}
  <!-- Disconnected by the idle reaper (PR 4): its next command connects again. -->
  {@const idled = !isVisible && n.state === "connected" && clusterStates.byId.get(id)?.state === "idle"}
  {@const state = isVisible ? "connected" : idled ? "idle" : n.state}
  <div
    class="node"
    class:visible={isVisible}
    data-testid="cluster-node"
    data-cluster={id}
    data-state={isVisible ? "visible" : state}
  >
    <div class="row">
      <button
        type="button"
        class="chevron"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${label(id)}`}
        title={open ? "Collapse" : isVisible ? "Expand" : "Expand: connects in the background"}
        onclick={() => void toggleNode(id)}>{open ? "▾" : "▸"}</button
      >
      <button
        type="button"
        class="name"
        aria-current={isVisible ? "true" : undefined}
        title={`${label(id)}: ${idled ? "Disconnected while idle: it connects again when used" : stateText(n.state, isVisible)}`}
        onclick={() => void showNode(id)}
      >
        <span
          class="dot {state}"
          style:background={colorOf(id) || null}
          aria-hidden="true"
        ></span>
        <span class="text">{label(id)}</span>
      </button>
      <span class="actions">
        <button
          type="button"
          class="icon"
          aria-label={`Open ${label(id)} in new window`}
          title="Open in new window"
          onclick={() => void openContextWindow(id)}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"
            />
          </svg>
        </button>
        {#if !isVisible && (n.state === "connected" || n.state === "failed")}
          <button
            type="button"
            class="icon"
            aria-label={`Disconnect ${label(id)}`}
            title="Disconnect: stops its logs, terminals and forwards in this window"
            onclick={() => void disconnectNode(id)}>✕</button
          >
        {/if}
      </span>
    </div>
    {#if open}
      <div class="body">
        {#if isVisible}
          <SidebarKinds />
        {:else if n.state === "consent" && n.prompt}
          <ExecPrompt
            source={n.prompt.source}
            commands={n.prompt.commands}
            compact
            onanswer={(allow) => answerNode(id, allow)}
          />
        {:else if n.state === "connecting" || (n.state === "connected" && !n.kinds)}
          <p class="muted note">Connecting…</p>
        {:else if n.state === "failed"}
          <p class="note error" data-testid="cluster-node-error">{n.error}</p>
          <button type="button" class="btn retry" onclick={() => void connectNode(id)}>Retry</button>
        {:else if n.state === "connected" && n.kinds}
          <button type="button" class="kind" onclick={() => void showNode(id, "overview")}>Overview</button>
          {#each sectionsOf(n.kinds) as s (s.title)}
            <details>
              <summary>{s.title}</summary>
              {#each s.kinds as k (k.id)}
                <button type="button" class="kind sub" title={k.label} onclick={() => void showNode(id, k.id)}
                  >{k.label}</button
                >
              {/each}
            </details>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="tree" role="group" aria-label="Clusters">
  {#each groups as g (g.source)}
    {@const closed = tree.closedGroups.has(g.source)}
    <div class="group" data-testid="cluster-group">
      <button
        type="button"
        class="group-title"
        aria-expanded={!closed}
        title={g.title}
        onclick={() => toggleGroup(g.source)}
        ><span aria-hidden="true">{closed ? "▸" : "▾"}</span> {g.label}</button
      >
      {#if !closed}
        {#each g.contexts as ctx (ctx.name)}
          {@render node(ctx)}
        {/each}
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .group-title {
    margin-top: 6px;
    padding: 4px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group:first-child .group-title {
    margin-top: 0;
  }
  button {
    text-align: left;
    background: transparent;
    color: var(--text-muted);
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  button:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .chevron {
    flex-shrink: 0;
    width: 18px;
    padding: 5px 0;
    font-size: 11px;
    text-align: center;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px 5px 2px;
    font-size: 13px;
  }
  .visible > .row .name {
    color: var(--text);
    font-weight: 600;
  }
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Not connected: hollow. Connected: filled. The shown one: accent. */
  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-sizing: border-box;
    border: 1.5px solid var(--text-muted);
  }
  .dot.connected {
    border-color: var(--green);
    background: var(--green);
  }
  .visible .dot {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .dot.connecting,
  .dot.consent {
    border-color: var(--amber);
  }
  .dot.failed {
    border-color: var(--red);
    background: var(--red);
  }
  .actions {
    display: flex;
    flex-shrink: 0;
    opacity: 0;
  }
  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
  }
  .icon {
    padding: 4px 5px;
    font-size: 11px;
    line-height: 1;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 10px;
    min-width: 0;
  }
  .note {
    margin: 4px 8px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--error-text);
  }
  .retry {
    align-self: flex-start;
    margin: 0 8px 6px;
  }
  .kind {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 10px;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind.sub {
    padding-left: 22px;
  }
  summary {
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
</style>
