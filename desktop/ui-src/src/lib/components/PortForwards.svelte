<script lang="ts">
  import { onDestroy } from "svelte";
  import { forwardLabel, forwardRows, forwardState, plannedUrl, portsLabel, savedPortsLabel } from "../forwards";
  import { app } from "../stores/app.svelte";
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

  const rows = $derived(forwardRows(forwards.saved, forwards.list));
  let starting = $state.raw<string[]>([]);

  $effect(() => {
    const running = forwards.list.length;
    const n = rows.length;
    app.count = `${n === 1 ? "1 forward" : `${n} forwards`}, ${running} running`;
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
  <p class="note muted">
    Forwards are saved for this cluster. They keep running when you close panels or leave this view; switching
    context or quitting stops them, and they come back stopped unless you check Start automatically.
  </p>
  {#if rows.length === 0}
    <p class="empty muted" data-testid="forwards-empty">
      No port-forwards. Start one from a pod, Service or workload: right-click it and pick Port forward…, or use the
      Forward buttons in its details.
    </p>
  {:else}
    <table>
      <thead>
        <tr>
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
            <td class="mono">
              {forwardLabel(target)}
              {#if s?.https}<span class="tag">https</span>{/if}
              {#if s?.auto_start}<span class="tag">auto-start</span>{/if}
            </td>
            <td class="mono">{f ? portsLabel(f) : s ? savedPortsLabel(s) : ""}</td>
            <td class="mono">{url || "—"}</td>
            <td class="mono">{f?.status.pod || "—"}</td>
            {#if f}
              {@const st = forwardState(f)}
              <td class:error-text={st.tone === "error"} class:ok={st.tone === "ok"}>{st.text}</td>
            {:else if error}
              <td class="error-text">{error}</td>
            {:else}
              <td class="muted">{s && starting.includes(s.id) ? "Starting…" : "Stopped"}</td>
            {/if}
            <td class="actions">
              {#if f}
                <button type="button" class="btn" aria-label="Open {f.url} in the browser" onclick={() => openForward(f)}
                  >Open</button
                >
                <button type="button" class="btn" aria-label="Copy {f.url}" onclick={() => copyForwardUrl(f)}
                  >Copy URL</button
                >
                <button type="button" class="btn" aria-label="Stop {f.url}" onclick={() => stopForward(f.id)}>Stop</button>
              {:else if s}
                <button
                  type="button"
                  class="btn primary"
                  aria-label="Start {forwardLabel(s.target)}:{s.remote}"
                  disabled={starting.includes(s.id)}
                  onclick={() => start(s.id)}>Start</button
                >
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
      </tbody>
    </table>
  {/if}
</div>

<style>
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
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .ok {
    color: var(--green);
  }
  .tag {
    display: inline-block;
    margin-left: 6px;
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
  .actions .btn + .btn {
    margin-left: 4px;
  }
</style>
