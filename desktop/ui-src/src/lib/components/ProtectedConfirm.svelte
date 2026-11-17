<script lang="ts">
  import { protect } from "../stores/contextMode.svelte";

  /** The typed confirmation of a change to a protected context (#338). */
  const pending = $derived(protect.queue[0] ?? null);
  let typed = $state("");
  const matches = $derived(!!pending && typed === pending.name);

  function close(value: string | null) {
    const p = pending;
    typed = "";
    p?.resolve(value);
  }

  function confirm() {
    if (matches) close(typed);
  }

  function onkeydown(e: KeyboardEvent) {
    // Not the dialogs underneath (the action dialog closes on Escape too).
    e.stopPropagation();
    if (e.key === "Escape") close(null);
    if (e.key === "Enter") confirm();
  }

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

{#if pending}
  {#key pending}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={(e) => e.target === e.currentTarget && close(null)} {onkeydown}>
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm a change to a protected cluster"
        data-testid="protected-confirm"
      >
        <h2><span class="badge">Protected</span> {pending.name}</h2>
        <p class="lead">{pending.what}</p>
        <p class="muted">This cluster is protected. Type its context name to go ahead.</p>
        <label class="field">
          <span>Type <span class="mono">{pending.name}</span> to confirm</span>
          <input
            class="input mono"
            aria-label="Context name"
            data-testid="protected-confirm-input"
            bind:value={typed}
            autocomplete="off"
            spellcheck="false"
            use:focus
          />
        </label>
        <div class="buttons">
          <button type="button" class="btn" onclick={() => close(null)}>Cancel</button>
          <button
            type="button"
            class="btn confirm"
            data-testid="protected-confirm-button"
            disabled={!matches}
            onclick={confirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  {/key}
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .dialog {
    width: min(440px, calc(100vw - 32px));
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
    word-break: break-all;
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--amber);
    border: 1px solid currentColor;
    flex-shrink: 0;
  }
  .lead {
    margin: 0 0 6px;
    font-size: 13px;
    word-break: break-word;
  }
  .muted {
    margin: 0 0 12px;
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
