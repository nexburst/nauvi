<script lang="ts">
  import { onMount } from "svelte";
  import { keyboard } from "../stores/keyboard.svelte";

  export interface MenuItem {
    label: string;
    danger?: boolean;
    /** Shown but not offered (e.g. while it is already running). */
    disabled?: boolean;
    /** Not offered because RBAC would refuse it (#340): says which permission is missing. */
    reason?: string;
    /** The key that does the same on a focused row (#494), shown at the end. */
    key?: string;
    run: () => void;
  }

  interface Props {
    x: number;
    y: number;
    /** Shown above the items: which object(s) the menu is about. */
    title: string;
    items: MenuItem[];
    onclose: () => void;
  }
  let { x, y, title, items, onclose }: Props = $props();

  let el = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);

  // Keep the menu inside the window.
  $effect(() => {
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    left = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    top = Math.max(4, Math.min(y, window.innerHeight - h - 4));
  });

  // While open, the menu has the keyboard: focus starts on the first item
  // and goes back where it was (the table) when the menu closes.
  onMount(() => {
    const before = document.activeElement as HTMLElement | null;
    keyboard.menus += 1;
    el?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      keyboard.menus -= 1;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  });

  const off = (i: MenuItem) => !!i.disabled || !!i.reason;

  function pick(item: MenuItem | undefined) {
    if (!item || off(item)) return;
    onclose();
    item.run();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onclose();
      return;
    }
    const all = [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    // Pick the item here, with the key's default prevented: left to the
    // button, the click would open a shell that then gets the same Enter
    // (its keypress) as input (#207).
    if ((e.key === "Enter" || e.key === " ") && at >= 0) {
      e.preventDefault();
      pick(items.filter((i) => !off(i))[at]);
      return;
    }
    const go = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 } as Record<string, number>)[
      e.key
    ];
    if (go === undefined) return;
    e.preventDefault();
    all[(go + all.length) % all.length].focus();
  }
</script>

<svelte:window {onkeydown} onresize={onclose} onblur={onclose} />
<!-- A click or right-click anywhere else dismisses the menu. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="shield" onclick={onclose} oncontextmenu={(e) => (e.preventDefault(), onclose())}></div>
<div class="menu" role="menu" data-testid="context-menu" bind:this={el} style:left="{left}px" style:top="{top}px">
  <div class="title" title={title}>{title}</div>
  {#each items as item, i (item.label)}
    <!-- The key sits over the item's end, outside it, so the item's text
         (and name) stays its label. -->
    <div class="item" role="none">
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class:danger={item.danger}
        class:denied={!!item.reason}
        class:keyed={!!item.key}
        disabled={off(item)}
        title={item.reason || undefined}
        aria-describedby={item.reason ? `menu-deny-${i}` : undefined}
        onclick={() => pick(item)}>{item.label}</button
      >
      {#if item.key}<kbd aria-hidden="true">{item.key}</kbd>{/if}
    </div>
    {#if item.reason}
      <div class="reason" role="none" id="menu-deny-{i}" data-testid="menu-reason">{item.reason}</div>
    {/if}
  {/each}
</div>

<style>
  .shield {
    position: fixed;
    inset: 0;
    z-index: 90;
  }
  .menu {
    position: fixed;
    z-index: 91;
    min-width: 170px;
    max-width: 280px;
    padding: 4px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
  }
  .title {
    padding: 4px 10px 6px;
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  button {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text);
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--bg-hover);
    outline: none;
  }
  .item {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  button.keyed {
    padding-right: 48px;
  }
  /* The key that does the same on a focused row (#494). */
  kbd {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    font-family: var(--font-num);
    font-size: 10.5px;
    line-height: 16px;
    color: var(--text-muted);
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  button:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  button.danger {
    color: var(--error-text);
  }
  button.denied {
    color: var(--text-muted);
    opacity: 0.6;
    cursor: not-allowed;
    padding-bottom: 0;
  }
  .reason {
    padding: 0 10px 6px;
    font-size: 11px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
</style>
