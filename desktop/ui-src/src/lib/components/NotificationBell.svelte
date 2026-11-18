<script lang="ts">
  import { badgeText } from "../notifications";
  import { notifications, toggleNotifications } from "../stores/notifications.svelte";

  /** The bell in the header (#326): opens the notification history, shows how many are unread. */
  const badge = $derived(badgeText(notifications.unread));
  const label = $derived(badge ? `Notifications, ${notifications.unread} unread` : "Notifications");
</script>

<button
  class="bell"
  class:active={notifications.open}
  type="button"
  aria-label={label}
  aria-pressed={notifications.open}
  title="Notifications"
  data-testid="notification-bell"
  onclick={toggleNotifications}
>
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
    />
  </svg>
  {#if badge}
    <span class="badge" data-testid="notification-count">{badge}</span>
  {/if}
</button>

<style>
  .bell {
    position: relative;
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
  }
  .bell:hover,
  .bell.active {
    color: var(--text);
    background: var(--bg-hover);
  }
  .badge {
    position: absolute;
    top: -3px;
    right: -5px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 8px;
    background: var(--red);
    color: var(--bg-sunken);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
  }
</style>
