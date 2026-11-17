<script lang="ts">
  import { api, visibleCluster } from "../cluster";
  import type { ServicePortInfo } from "../bindings";
  import { forwardLabel } from "../forwards";
  import { closeForwardDialog, confirmForwardDialog, forwardDialog } from "../stores/forwards.svelte";

  /** Start a port-forward to a pod, Service or workload: remote port
   *  (offered from the Service's ports), an optional local port and how to
   *  open it. Also edits a saved forward (#217). */
  const target = $derived(forwardDialog.target);
  const editing = $derived(forwardDialog.editId !== "");
  let servicePorts = $state.raw<ServicePortInfo[]>([]);

  $effect(() => {
    const t = target;
    servicePorts = [];
    if (!t || t.kind !== "service") return;
    api(visibleCluster())
      .cmdServicePorts(t.namespace, t.name)
      .then((ports) => {
        if (forwardDialog.target !== t) return;
        servicePorts = ports.filter((p) => p.protocol === "TCP");
        if (!forwardDialog.remote && servicePorts.length > 0) forwardDialog.remote = String(servicePorts[0].port);
      })
      .catch(() => {
        // Typing the port still works.
      });
  });

  function onkeydown(e: KeyboardEvent) {
    if (target && e.key === "Escape") closeForwardDialog();
  }

  function onEnter(e: KeyboardEvent) {
    if (e.key === "Enter") void confirmForwardDialog();
  }

  function focusFirst(node: HTMLElement) {
    node.querySelector<HTMLElement>("input, select")?.focus();
  }
</script>

<svelte:window {onkeydown} />

{#if target}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeForwardDialog()}>
    <div class="dialog" role="dialog" data-testid="forward-dialog" aria-modal="true" aria-label={editing ? "Edit port forward" : "Port forward"} use:focusFirst>
      <h2>{editing ? "Edit port forward" : "Port forward"}</h2>
      <p class="lead mono">{forwardLabel(target)}</p>

      {#if servicePorts.length > 0}
        <label class="field">
          Service port
          <select class="select" aria-label="Service port" bind:value={forwardDialog.remote}>
            {#each servicePorts as p (p.port)}
              <option value={String(p.port)}>{p.port}{p.name ? `/${p.name}` : ""} → {p.target_port}</option>
            {/each}
          </select>
        </label>
      {:else}
        <label class="field">
          Remote port
          <input
            class="input"
            aria-label="Remote port"
            placeholder="80 or a port name"
            bind:value={forwardDialog.remote}
            onkeydown={onEnter}
          />
        </label>
      {/if}

      <label class="field">
        Local port
        <input
          class="input"
          aria-label="Local port"
          placeholder="automatic"
          inputmode="numeric"
          bind:value={forwardDialog.local}
          onkeydown={onEnter}
        />
        <span class="hint muted"
          >Empty: the remote port if it is free and at least 1024, otherwise a free one. 0: any free port.</span
        >
      </label>

      <label class="check">
        <input type="checkbox" aria-label="https" bind:checked={forwardDialog.https} />
        <span>https <span class="muted">(the target speaks TLS: open and copy an https:// URL)</span></span>
      </label>
      <label class="check">
        <input type="checkbox" aria-label="Open in browser" bind:checked={forwardDialog.openInBrowser} />
        <span>Open in browser when it starts</span>
      </label>
      <label class="check">
        <input type="checkbox" aria-label="Start automatically" bind:checked={forwardDialog.autoStart} />
        <span>Start automatically <span class="muted">(when the app connects to this cluster)</span></span>
      </label>

      <p class="hint muted">
        Saved for this cluster in Network → Port Forwards. It keeps running when you close panels; switching context
        or quitting stops it.
      </p>

      {#if forwardDialog.error}<p class="error-text" role="alert">{forwardDialog.error}</p>{/if}

      <div class="buttons">
        <button type="button" class="btn" disabled={forwardDialog.busy} onclick={closeForwardDialog}>Cancel</button>
        <button
          type="button"
          class="btn primary"
          data-testid="forward-confirm"
          disabled={forwardDialog.busy}
          onclick={() => void confirmForwardDialog()}
        >
          {#if editing}
            {forwardDialog.busy ? "Saving…" : forwardDialog.wasRunning ? "Save and restart" : "Save"}
          {:else}
            {forwardDialog.busy ? "Starting…" : "Start"}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  .lead {
    margin: 0 0 12px;
    font-size: 13px;
    word-break: break-all;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .check {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .check .muted {
    font-size: 12px;
  }
  .hint {
    font-size: 12px;
    margin: 0 0 8px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
