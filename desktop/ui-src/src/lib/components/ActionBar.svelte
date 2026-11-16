<script lang="ts">
  import { onMount } from "svelte";
  import ActionIcon from "./ActionIcon.svelte";
  import { commands } from "../bindings";
  import type { ActionAccess } from "../bindings";
  import { panelActions } from "../actions";
  import type { PanelAction } from "../actions";
  import { dockMenuFor } from "../dock";
  import type { DockTabSpec } from "../dock";
  import { kindOfResource, requestAction } from "../stores/actions.svelte";
  import { openDockTab } from "../stores/dock.svelte";
  import { copyLink } from "../stores/links.svelte";
  import type { Target } from "../stores/detail.svelte";

  /** The detail panel's header of action icons (#218): the row menu's Logs
   *  and Shell, every action the registry lists for the kind, Edit and Copy
   *  link (#299, never greyed: it only reads the kubeconfig).
   *  Actions RBAC would refuse are greyed, with the reason in the tooltip.
   *  `disabled` once the object is gone. */
  interface Props {
    target: Target;
    disabled?: boolean;
    /** Shows the YAML editor. */
    onEdit: () => void;
    /** Fills in what the panel knows (a pod's containers) before a dock tab opens. */
    dockSpec?: (spec: DockTabSpec) => DockTabSpec;
  }
  let { target, disabled = false, onEdit, dockSpec = (s) => s }: Props = $props();

  const kind = $derived(kindOfResource(target.resource));
  const items = $derived(
    panelActions(dockMenuFor(target.resource, target.namespace, target.name), kind?.actions ?? []),
  );

  /** Answers of the access check, by id. Until it answers, everything is offered. */
  let access = $state.raw(new Map<string, ActionAccess>());
  onMount(() => {
    let live = true;
    const ids = items.map((a) => a.id).filter((id) => id !== "link");
    commands
      .cmdCheckActions(target.resource, target.namespace, ids)
      .then((list) => {
        if (live) access = new Map(list.map((a) => [a.id, a]));
      })
      // A check that cannot be made counts as allowed.
      .catch(() => {});
    return () => (live = false);
  });

  const denied = (a: PanelAction<DockTabSpec>) => {
    const r = access.get(a.id);
    return r && !r.allowed ? r.reason : "";
  };

  function run(a: PanelAction<DockTabSpec>) {
    if (disabled || denied(a)) return;
    tip = null;
    if (a.run === "dock") openDockTab(dockSpec(a.spec));
    else if (a.run === "edit") onEdit();
    else if (a.run === "link") void copyLink(target.resource, target.namespace, target.name);
    else if (kind) requestAction(kind, [{ namespace: target.namespace, name: target.name }], a.action);
  }

  // One tooltip for the bar, under the hovered or focused button, kept
  // inside the panel.
  let bar = $state<HTMLDivElement | null>(null);
  let tipEl = $state<HTMLDivElement | null>(null);
  let tip = $state<{ a: PanelAction<DockTabSpec>; center: number } | null>(null);
  let tipLeft = $state(0);
  function showTip(a: PanelAction<DockTabSpec>, el: HTMLElement) {
    tip = { a, center: el.offsetLeft + el.offsetWidth / 2 };
  }
  $effect(() => {
    if (!tip || !tipEl || !bar) return;
    const w = tipEl.offsetWidth;
    tipLeft = Math.max(4, Math.min(tip.center - w / 2, bar.clientWidth - w - 4));
  });

  /** Left and Right move along the bar (the WAI-ARIA toolbar pattern); Tab
   *  reaches every button too. (Home and End stay the table's.) */
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = [...(bar?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    e.preventDefault();
    e.stopPropagation();
    buttons[next].focus();
  }
</script>

{#if items.length > 0}
  <!-- The toolbar's buttons take the focus, not the toolbar. -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="bar" role="toolbar" aria-label="Actions" bind:this={bar} {onkeydown}>
    {#each items as a (a.id)}
      {@const reason = denied(a)}
      <button
        type="button"
        class="icon"
        class:danger={a.danger}
        class:denied={!!reason}
        data-action={a.id}
        {disabled}
        aria-disabled={reason ? "true" : undefined}
        aria-describedby={reason ? `deny-${a.id}` : undefined}
        onclick={() => run(a)}
        onmouseenter={(e) => showTip(a, e.currentTarget)}
        onmouseleave={() => (tip = null)}
        onfocus={(e) => showTip(a, e.currentTarget)}
        onblur={() => (tip = null)}
      >
        <ActionIcon id={a.id} />
        <span class="sr">{a.label}</span>
      </button>
      <!-- Outside the button, so its text stays the label. -->
      {#if reason}<span class="sr" id="deny-{a.id}">{reason}</span>{/if}
    {/each}
    {#if tip}
      <div class="tip" role="tooltip" data-testid="action-tip" bind:this={tipEl} style:left="{tipLeft}px">
        <span class="tip-label">{tip.a.tip}</span>
        {#if denied(tip.a)}<span class="tip-reason">{denied(tip.a)}</span>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .bar {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px 12px 6px;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    padding: 0;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
  }
  .icon:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .icon:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    color: var(--text);
  }
  .icon.danger {
    color: var(--error-text);
  }
  .icon.danger:hover {
    border-color: var(--red);
  }
  .icon:disabled,
  .icon.denied {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .icon:disabled:hover,
  .icon.denied:hover {
    background: transparent;
    border-color: transparent;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tip {
    position: absolute;
    top: calc(100% - 2px);
    z-index: 5;
    max-width: calc(100% - 8px);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 8px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    font-size: 12px;
    font-weight: 400;
    pointer-events: none;
    word-break: normal;
  }
  .tip-reason {
    color: var(--text-muted);
  }
</style>
