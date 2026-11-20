<script lang="ts">
  import { actionUi, dismissNotice } from "../stores/actions.svelte";
</script>

{#if actionUi.notice}
  <div class="notice" class:fail={!actionUi.notice.ok} role={actionUi.notice.ok ? "status" : "alert"} data-testid="action-notice">
    <span class="text">{actionUi.notice.text}</span>
    <span class="end">
      {#each actionUi.notice.actions as a (a.label)}
        <button type="button" class="btn" onclick={a.run}>{a.label}</button>
      {/each}
      <button type="button" class="x" aria-label="Dismiss" onclick={dismissNotice}>✕</button>
    </span>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin: 12px 16px 0;
    padding: 8px 12px;
    background: rgba(63, 178, 127, 0.12);
    border: 1px solid var(--green);
    border-radius: 6px;
    font-size: 13px;
  }
  .notice.fail {
    background: rgba(229, 72, 77, 0.15);
    border-color: var(--red);
    color: var(--error-text);
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .end {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
  }
</style>
