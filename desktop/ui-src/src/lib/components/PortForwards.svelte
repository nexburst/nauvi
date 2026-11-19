<script lang="ts">
  import CalmWater from "./CalmWater.svelte";
  import { onDestroy } from "svelte";
  import { forwardLabel, forwardRows, forwardsCount, forwardState, plannedUrl, portsLabel, savedPortsLabel } from "../forwards";
  import { api } from "../cluster";
  import type { ForwardInfo } from "../bindings";
  import { needsClusterLabels } from "../hidden";
  import { app, currentContextName } from "../stores/app.svelte";
  import { contextLabel } from "../stores/catalog.svelte";
  import { pollWindowForwards, refreshWindowForwards, windowItems } from "../stores/hidden.svelte";
  import ClusterLabel from "./ClusterLabel.svelte";
  import {
    copyForwardUrl,
    deleteSaved,
    forwards,
    openEditForwardDialog,
    openForward,
    pollForwards,
    startSaved,
    stopForward,
  } from "../stores/forwards.svelte";

  /** Network → Port Forwards: the forwards saved for this cluster (#217)
   *  and the ones running in this window, with their live status. Forwards
   *  outlive this view; leaving it stops nothing. */
  const stopPolling = pollForwards();
  onDestroy(stopPolling);
  // The forwards of the window's other clusters (ADR 0007), labelled.
  onDestroy(pollWindowForwards());

  const rows = $derived(forwardRows(forwards.saved, forwards.list));
  const visible = $derived(currentContextName());
  /** Forwards running on the other clusters this window is connected to. */
  const others = $derived(windowItems.forwards.filter((f) => f.cluster !== visible));
  const labelled = $derived(
    needsClusterLabels([...rows.map(() => visible), ...others.map((f) => f.cluster)], visible),
  );

  async function stopOther(cluster: string, f: ForwardInfo) {
    try {
      await api(cluster).cmdPortforwardStop(f.id);
    } finally {
      await refreshWindowForwards();
    }
  }
  let starting = $state.raw<string[]>([]);
  const ELSEWHERE_HINT = "Running in another window: stop it there to start it here";

  // Reads app.count too: clicking Port Forwards while it is shown clears it
  // (setView) without remounting this view, and the next poll may be late
  // in a background window (#320).
  $effect(() => {
    const text = forwardsCount(rows, forwards.elsewhere);
    if (app.count !== text) app.count = text;
  });

  async function start(id: string) {
    const f = forwards.saved.find((s) => s.id === id);
    if (!f || starting.includes(id)) return;
    starting = [...starting, id];
    try {
      await startSaved(f);
    } finally {
      starting = starting.filter((s) => s !== id);
    }
  }
</script>

<div class="forwards" data-testid="port-forwards">
  <div class="lead">
    <h2>Port forwards</h2>
    <p
      class="note muted"
      title="Forwards are saved per cluster. They keep running when you close panels, leave this view or show another cluster (they are listed here with their cluster); disconnecting the cluster or quitting stops them, and they come back stopped unless you check Start automatically."
    >
      Forwards are saved per cluster. They keep running while you work elsewhere in this window.
    </p>
  </div>
  {#if rows.length === 0 && others.length === 0}
    <CalmWater mark="lighthouse">
      <p class="empty muted" data-testid="forwards-empty">
        No port-forwards. Start one from a pod, Service or workload: right-click it and pick Port forward…, or use
        the Forward buttons in its details.
      </p>
    </CalmWater>
  {:else}
    <table>
      <thead>
        <tr>
          {#if labelled}<th>Cluster</th>{/if}
          <th>Target</th>
          <th>Ports</th>
          <th>Local URL</th>
          <th>Pod</th>
          <th>Status</th>
          <th><span class="hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.key)}
          {@const f = r.running}
          {@const s = r.saved}
          {@const target = (f?.target ?? s?.target)!}
          {@const url = f ? f.url : s ? plannedUrl(s) : ""}
          {@const error = s ? forwards.errors[s.id] : ""}
          <tr data-testid="forward-row" class:stopped={!f}>
            {#if labelled}<td class="cluster" data-testid="forward-cluster"><ClusterLabel id={visible} /></td>{/if}
            <td class="mono target">
              {forwardLabel(target)}
              {#if s?.https || s?.auto_start}
                <div class="tags">
                  {#if s?.https}<span class="tag">https</span>{/if}
                  {#if s?.auto_start}<span class="tag">auto-start</span>{/if}
                </div>
              {/if}
            </td>
            <td class="mono nowrap" data-testid="forward-ports">{f ? portsLabel(f) : s ? savedPortsLabel(s) : ""}</td>
            <td class="mono nowrap" data-testid="forward-url">{url || "—"}</td>
            <td class="mono">{f?.status.pod || "—"}</td>
            {#if f}
              {@const st = forwardState(f)}
              <td class="status" class:error-text={st.tone === "error"} class:ok={st.tone === "ok"}>{st.text}</td>
            {:else if s && forwards.elsewhere.includes(s.id)}
              <td class="status muted" data-testid="forward-elsewhere">Running in another window</td>
            {:else if error}
              <td class="status error-text">{error}</td>
            {:else}
              <td class="status muted">{s && starting.includes(s.id) ? "Starting…" : "Stopped"}</td>
            {/if}
            <td class="actions">
              {#if f}
                <button type="button" class="btn" aria-label="Open {f.url} in the browser" onclick={() => openForward(f)}
                  >Open</button
                >
                <button type="button" class="btn" aria-label="Copy {f.url}" onclick={() => copyForwardUrl(f)}
                  >Copy</button
                >
                <button type="button" class="btn" aria-label="Stop {f.url}" onclick={() => stopForward(f.id)}>Stop</button>
              {:else if s}
                {@const away = forwards.elsewhere.includes(s.id)}
                <!-- Another window runs it (#297): starting it here would only fail
                     with "port in use". The title is on the button and on a wrapper:
                     some webviews show no tooltip on a disabled button. -->
                <span class="start-wrap" title={away ? ELSEWHERE_HINT : undefined} data-testid="forward-start">
                  <button
                    type="button"
                    class="btn primary"
                    aria-label="Start {forwardLabel(s.target)}:{s.remote}"
                    title={away ? ELSEWHERE_HINT : undefined}
                    disabled={away || starting.includes(s.id)}
                    onclick={() => start(s.id)}>Start</button
                  >
                </span>
              {/if}
              {#if s}
                <button
                  type="button"
                  class="btn"
                  aria-label="Edit {forwardLabel(s.target)}:{s.remote}"
                  onclick={() => openEditForwardDialog(s)}>Edit</button
                >
                <button
                  type="button"
                  class="btn"
                  aria-label="Delete {forwardLabel(s.target)}:{s.remote}"
                  onclick={() => deleteSaved(s)}>Delete</button
                >
              {/if}
            </td>
          </tr>
        {/each}
        {#each others as o (o.forward.id)}
          {@const f = o.forward}
          {@const st = forwardState(f)}
          <tr data-testid="forward-row-other" data-cluster={o.cluster}>
            <td class="cluster" data-testid="forward-cluster"><ClusterLabel id={o.cluster} /></td>
            <td class="mono target">{forwardLabel(f.target)}</td>
            <td class="mono nowrap">{portsLabel(f)}</td>
            <td class="mono nowrap">{f.url}</td>
            <td class="mono">{f.status.pod || "—"}</td>
            <td class="status" class:error-text={st.tone === "error"} class:ok={st.tone === "ok"}>{st.text}</td>
            <td class="actions">
              <button type="button" class="btn" aria-label="Open {f.url} in the browser" onclick={() => openForward(f)}
                >Open</button
              >
              <button type="button" class="btn" aria-label="Copy {f.url}" onclick={() => copyForwardUrl(f)}>Copy</button>
              <button
                type="button"
                class="btn"
                aria-label="Stop {f.url} on {contextLabel(o.cluster)}"
                onclick={() => stopOther(o.cluster, f)}>Stop</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .lead {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 12px;
  }
  .lead h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .lead .note {
    margin: 0;
    font-size: 12px;
  }
  .empty {
    margin: 0;
    max-width: 520px;
  }
  .forwards {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
  }
  .note,
  .empty {
    font-size: 13px;
    margin: 0 0 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    color: var(--text-muted);
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    word-break: break-all;
    /* The global nowrap would let a long status push the buttons out of view (#292, #293). */
    white-space: normal;
  }
  .status {
    word-break: normal;
    overflow-wrap: anywhere;
    min-width: 160px;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  /* Ports and URLs are short and must not break mid-number (#320); the
     target and pod names take the wrapping instead. */
  .nowrap {
    white-space: nowrap;
    word-break: normal;
  }
  .ok {
    color: var(--green);
  }
  .target {
    max-width: 280px;
  }
  .cluster {
    max-width: 160px;
    word-break: normal;
  }
  .tags {
    margin-top: 3px;
  }
  .tag {
    display: inline-block;
    margin-right: 6px;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 11px;
    color: var(--text-muted);
    word-break: normal;
  }
  .actions {
    white-space: nowrap;
    word-break: normal;
    text-align: right;
  }
  .actions .btn + .btn,
  .actions .start-wrap + .btn {
    margin-left: 4px;
  }
  .start-wrap {
    display: inline-block;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
