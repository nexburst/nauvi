<script lang="ts">
  import Icon from "../icons/Icon.svelte";
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
  <Icon name="bell" size={18} />
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
