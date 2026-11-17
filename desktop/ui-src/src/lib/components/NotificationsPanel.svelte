<script lang="ts">
  import { NOTIFICATION_CAP, notificationTime, openProblem, targetText } from "../notifications";
  import type { NotificationEntry } from "../notifications";
  import { app, currentContextName, openObject, setNamespaces } from "../stores/app.svelte";
  import { kindOfResource } from "../stores/actions.svelte";
  import { clearNotifications, closeNotifications, notifications } from "../stores/notifications.svelte";
  import { settings } from "../stores/settings.svelte";

  /** The notification history of this window (#326), newest first. */
  const LEVELS = { success: "Done", info: "Info", warning: "Warning", error: "Error" } as const;

  const current = $derived(currentContextName());

  function problem(e: NotificationEntry): string {
    const p = openProblem(e, current);
    if (p || !e.target) return p;
    return kindOfResource(e.target.resource) ? "" : `This cluster does not serve ${e.target.resource.kind} objects.`;
  }

  function open(e: NotificationEntry) {
    const t = e.target;
    const kind = t && kindOfResource(t.resource);
    if (!t || !kind) return;
    const scope = app.selectedNamespaces;
    if (t.namespace && scope.length > 0 && !scope.includes(t.namespace)) setNamespaces([t.namespace]);
    closeNotifications();
    openObject(kind, t.namespace, t.name);
  }
</script>

<aside data-testid="notifications-panel" aria-label="Notifications">
  <div class="header">
    <span>Notifications</span>
    <div class="actions">
      <button
        type="button"
        class="btn"
        disabled={notifications.list.length === 0}
        onclick={clearNotifications}>Clear all</button
      >
      <button type="button" class="close" aria-label="Close notifications" onclick={closeNotifications}>✕</button>
    </div>
  </div>
  {#if notifications.list.length === 0}
    <p class="empty" data-testid="notifications-empty">
      No notifications yet. Results of actions, errors and warnings this window shows are kept here.
    </p>
  {:else}
    <ul class="list">
      {#each notifications.list as e (e.id)}
        {@const why = problem(e)}
        <li class={`item ${e.level}`} data-testid="notification">
          <div class="meta">
            <span class="level">{LEVELS[e.level]}</span>
            <time datetime={new Date(e.at).toISOString()}>{notificationTime(e.at, Date.now(), settings.current.time_zone)}</time>
            {#if e.count > 1}<span class="count" title="Shown {e.count} times in a row">×{e.count}</span>{/if}
            {#if e.context}<span class="context" title="Context">{e.context}</span>{/if}
          </div>
          <p class="message">{e.message}</p>
          {#if e.target}
            <button type="button" class="link" disabled={!!why} title={why || "Open its details"} onclick={() => open(e)}>
              {targetText(e.target)}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="foot">The last {NOTIFICATION_CAP} of this window, until it closes.</p>
  {/if}
</aside>

<style>
  aside {
    width: 360px;
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
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn {
    font-size: 12px;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: none;
    font-size: 14px;
    cursor: pointer;
  }
  .empty {
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .item {
    padding: 10px 16px 10px 13px;
    border-bottom: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    font-size: 13px;
  }
  .item.success {
    border-left-color: var(--green);
  }
  .item.warning {
    border-left-color: var(--amber);
  }
  .item.error {
    border-left-color: var(--red);
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .level {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .item.error .level {
    color: var(--error-text);
  }
  .item.warning .level {
    color: var(--amber);
  }
  .item.success .level {
    color: var(--green);
  }
  .context {
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .message {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .link {
    margin-top: 4px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .link:disabled {
    color: var(--text-muted);
    cursor: not-allowed;
  }
  .foot {
    margin: 0;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 11px;
  }
</style>
