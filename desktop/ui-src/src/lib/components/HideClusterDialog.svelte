<script lang="ts">
  import { runningText } from "../hidden";
  import { contextLabel } from "../stores/catalog.svelte";
  import { cancelHide, confirmHide, hideDialog } from "../stores/hidden.svelte";
  import ClusterLabel from "./ClusterLabel.svelte";

  /** "Remove = hide" (ADR 0007): asks before hiding a cluster, and says
   *  what stops if something runs there. */
  const running = $derived(runningText(hideDialog.running));

  /** "Cancel" is the safe default: focused, and what Escape does. */
  function focus(node: HTMLElement) {
    node.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (hideDialog.id && e.key === "Escape") cancelHide();
  }
</script>

<svelte:window {onkeydown} />

{#if hideDialog.id}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && cancelHide()}>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-label="Hide cluster" data-testid="hide-dialog">
      <h2>Hide <ClusterLabel id={hideDialog.id} />?</h2>
      <p>
        It leaves the cluster tree, the context selector and the palette. It is only hidden in nauvi: your kubeconfig
        is not changed.
      </p>
      {#if running}
        <p class="warn" data-testid="hide-running">
          {running} {hideDialog.running.forwards + hideDialog.running.tabs === 1 ? "runs" : "run"} on it in this window.
          Hiding disconnects it, so {hideDialog.running.forwards + hideDialog.running.tabs === 1 ? "it stops" : "they stop"}.
        </p>
      {/if}
      <p class="muted">To show it again: the catalog, Show hidden, then Unhide.</p>
      <div class="buttons">
        <button type="button" class="btn" use:focus onclick={cancelHide}>Cancel</button>
        <button
          type="button"
          class="btn primary"
          disabled={hideDialog.busy}
          aria-label={`${running ? "Stop and hide" : "Hide"} ${contextLabel(hideDialog.id)}`}
          onclick={() => void confirmHide()}>{running ? "Stop and hide" : "Hide"}</button
        >
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
    z-index: 110;
  }
  .dialog {
    width: min(440px, calc(100vw - 32px));
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 10px;
    font-size: 15px;
    min-width: 0;
  }
  p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.45;
  }
  .warn {
    padding: 6px 8px;
    border: 1px solid var(--amber);
    border-radius: 6px;
  }
  .muted {
    color: var(--text-muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
</style>
