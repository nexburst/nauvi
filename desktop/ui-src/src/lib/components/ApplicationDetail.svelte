<script lang="ts">
  import type { Application, AppWorkload } from "../bindings";
  import { healthTone, sourceLabel } from "../applications";
  import { HELM_VIEW } from "../helm";
  import { toneOf, workloadKind } from "../workloads";
  import { kinds, openObject, setView } from "../stores/app.svelte";
  import { selectApplication } from "../stores/applications.svelte";
  import { selectRelease } from "../stores/helm.svelte";

  /** Side panel of one application (#226): its labels and its workloads,
   *  each opening its own detail, and its Helm release. */
  let { target }: { target: Application } = $props();

  function open(w: AppWorkload) {
    const kind = workloadKind(kinds.all, w.group, w.kind);
    if (kind) openObject(kind, w.namespace, w.name);
  }

  function openRelease() {
    setView(HELM_VIEW);
    selectRelease({ namespace: target.namespace, name: target.name });
  }

  const facts = $derived(
    [
      ["Namespace", target.namespace],
      ["Source", sourceLabel(target.source)],
      ["Components", target.components.join(", ")],
      ["Version", target.versions.join(", ")],
      ["Managed by", target.managed_by.join(", ")],
    ].filter(([, v]) => v),
  );
</script>

<aside data-testid="application-detail">
  <div class="header">
    <span class="title"><span class="muted">Application</span> {target.namespace}/{target.name}</span>
    <button type="button" class="close" aria-label="Close details" onclick={() => selectApplication(null)}>✕</button>
  </div>

  <div class="body">
    <p class="health" data-health={target.health}>
      <span class="dot {healthTone(target.health)}"></span><strong>{target.health}</strong>
      {#if target.reason}<span class="muted reason">{target.reason}</span>{/if}
    </p>

    <dl>
      {#each facts as [k, v] (k)}
        <dt>{k}</dt>
        <dd>{v}</dd>
      {/each}
    </dl>

    {#if target.source === "Helm"}
      <button type="button" class="btn" onclick={openRelease}>Open Helm release</button>
    {/if}

    <h3>Workloads ({target.workloads.length})</h3>
    <ul class="workloads" aria-label="Workloads">
      {#each target.workloads as w (w.kind + "/" + w.namespace + "/" + w.name)}
        {@const kind = workloadKind(kinds.all, w.group, w.kind)}
        <li>
          <button
            type="button"
            class="workload"
            data-testid="application-workload"
            disabled={!kind}
            title={kind ? `Open ${w.kind} ${w.name}` : `${w.kind} is not served by this cluster`}
            onclick={() => open(w)}
          >
            <span class="dot {toneOf(w.status)}"></span>
            <span class="kind muted">{w.kind}</span>
            <span class="wname">{w.name}</span>
            <span class="status">{w.problem || w.status}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
</aside>

<style>
  aside {
    width: 420px;
    flex-shrink: 0;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 13px;
    word-break: break-all;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: none;
    font-size: 14px;
    cursor: pointer;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px;
    font-size: 13px;
  }
  .health {
    margin: 0 0 12px;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
  }
  .reason {
    font-size: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0 0 12px;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 16px 0 6px;
  }
  .workloads {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .workload {
    width: 100%;
    display: grid;
    grid-template-columns: 14px 90px minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    padding: 6px 4px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .workload:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .workload:disabled {
    cursor: default;
  }
  .wname,
  .status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    font-size: 12px;
    color: var(--text-muted);
    max-width: 160px;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .ok {
    background: var(--green);
  }
  .progress {
    background: var(--amber);
  }
  .bad {
    background: var(--red);
  }
  .done {
    background: var(--accent);
  }
  .idle {
    background: var(--text-muted);
  }
</style>
