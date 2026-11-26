<script lang="ts">
  import { untrack } from "svelte";
  import type { ContextInfo } from "../bindings";
  import { groupContexts, sectionsOf, stateText } from "../clusterTree";
  import { visibleDot } from "../health";
  import { app, currentContextName, openContextWindow } from "../stores/app.svelte";
  import { contextFullName, contextLabel } from "../stores/catalog.svelte";
  import { contextSettings, settings } from "../stores/settings.svelte";
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
  import { askHide, isHidden, refreshWindowForwards, windowItems } from "../stores/hidden.svelte";
  import { shownContexts } from "../hidden";
  import ExecPrompt from "./catalog/ExecPrompt.svelte";
  import SidebarKinds from "./SidebarKinds.svelte";
  import Icon from "../icons/Icon.svelte";
  import { kindIcon } from "../kindIcons";

  // Every kubeconfig context, by source (ADR 0007). Nothing is asked of a
  // cluster until its node is expanded or selected.
  const visible = $derived(currentContextName());
  // Hidden ones are left out (ADR 0007), unless shown here or running
  // something in this window: those keep a node, marked hidden.
  const groups = $derived(
    groupContexts(
      shownContexts(app.contexts, settings.current.hidden_contexts, [visible, ...windowItems.byCluster.keys()]),
    ),
  );

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

  // The tree first shows its contexts: the start-up budget (QA
  // `multicluster`) reads this mark.
  let marked = false;
  $effect(() => {
    if (marked || groups.length === 0) return;
    marked = true;
    performance.mark("nauvi:cluster-tree");
  });

  const label = (id: string) => contextLabel(id);
  const colorOf = (id: string) => contextSettings(id).color;

  /** Disconnect `id`: its forwards stopped, so the lists that show them
   *  follow now rather than on their next poll (#498). */
  async function disconnect(id: string) {
    if (await disconnectNode(id)) await refreshWindowForwards();
  }
</script>

{#snippet node(ctx: ContextInfo)}
  {@const id = ctx.name}
  {@const n = nodeOf(id)}
  {@const isVisible = id === visible}
  {@const open = isExpanded(id)}
  <!-- Disconnected by the idle reaper (PR 4): its next command connects again. -->
  {@const idled = !isVisible && n.state === "connected" && clusterStates.byId.get(id)?.state === "idle"}
  <!-- The one shown follows the header status (#462): red while it does not answer. -->
  {@const state = isVisible ? visibleDot(app.status) : idled ? "idle" : n.state}
  <div
    class="node"
    class:visible={isVisible}
    class:hidden-ctx={isHidden(id)}
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
        onclick={() => void toggleNode(id)}><Icon name="chevronDown" size={12} class="chevron" /></button
      >
      <button
        type="button"
        class="name"
        aria-current={isVisible ? "true" : undefined}
        title={`${contextFullName(id)}: ${idled ? "Disconnected while idle: it connects again when used" : stateText(n.state, isVisible)}${isVisible && state !== "connected" ? ` (${app.status.text})` : ""}`}
        onclick={() => void showNode(id)}
      >
        <span
          class="dot {state}"
          style:background={state === "failed" ? null : colorOf(id) || null}
          aria-hidden="true"
        ></span>
        <span class="text">{label(id)}</span>
        {#if isHidden(id)}<span class="hidden-tag" title="Hidden in nauvi: unhide it in the catalog">hidden</span>{/if}
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
        {#if !isVisible && !isHidden(id)}
          <button
            type="button"
            class="icon"
            aria-label={`Hide ${label(id)}`}
            title="Hide in nauvi: your kubeconfig is not changed"
            onclick={() => void askHide(id)}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2z"
              />
            </svg>
          </button>
        {/if}
        {#if !isVisible && (n.state === "connected" || n.state === "failed")}
          <button
            type="button"
            class="icon"
            aria-label={`Disconnect ${label(id)}`}
            title="Disconnect: stops its logs, terminals and forwards in this window"
            onclick={() => void disconnect(id)}>✕</button
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
          <button type="button" class="kind" onclick={() => void showNode(id, "overview")}
            ><Icon name="dashboard" size={16} /><span class="kind-label">Overview</span></button
          >
          {#each sectionsOf(n.kinds) as s (s.title)}
            <details>
              <summary><Icon name="chevronRight" size={12} class="chevron" />{s.title}</summary>
              {#each s.kinds as k (k.id)}
                <button type="button" class="kind sub" title={k.label} onclick={() => void showNode(id, k.id)}
                  ><Icon name={kindIcon(k)} size={16} /><span class="kind-label">{k.label}</span></button
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
        ><Icon name="chevronDown" size={12} class="chevron" /><span class="group-label">{g.label}</span></button
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
  /* A kubeconfig source: a quiet label in the UI font (#481), the file's
     name as the cluster tree's top level. */
  .group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 3px 6px;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-muted);
    min-width: 0;
  }
  .group-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-title:hover {
    background: transparent;
  }
  .group-title :global(.chevron),
  .chevron :global(.chevron),
  summary :global(.chevron) {
    opacity: 0.7;
    transition: transform 140ms var(--ease-out);
  }
  .group-title[aria-expanded="false"] :global(.chevron),
  .chevron[aria-expanded="false"] :global(.chevron) {
    transform: rotate(-90deg);
  }
  details[open] > summary :global(.chevron) {
    transform: rotate(90deg);
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
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .chevron {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    padding: 7px 0;
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
  .hidden-ctx > .row .text {
    font-style: italic;
  }
  .hidden-tag {
    flex-shrink: 0;
    font-size: 10px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
  }
  .visible > .row .name {
    color: var(--text);
    font-weight: 600;
  }
  /* The label is short already (#383); a long one wraps onto a second
     line rather than losing its end. */
  .text {
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    line-height: 1.3;
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
    box-shadow:
      0 0 0 2px var(--bg-sunken),
      0 0 0 3.5px color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .dot.connecting,
  .dot.consent {
    border-color: var(--amber);
  }
  .dot.failed {
    border-color: var(--red);
    background: var(--red);
  }
  /* Over the end of the row, so they take no room from the name. */
  .actions {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    display: flex;
    background: var(--bg-sunken);
    border-radius: 6px;
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
    padding-left: 4px;
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
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: var(--text-base);
    color: var(--text);
  }
  .kind :global(.icon) {
    color: var(--text-muted);
  }
  .kind-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind.sub {
    padding-left: 20px;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-muted);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
</style>
