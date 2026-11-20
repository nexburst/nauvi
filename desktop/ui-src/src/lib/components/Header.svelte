<script lang="ts">
  import { app, openContextWindow, refresh, setView, switchContext } from "../stores/app.svelte";
  import { CATALOG_VIEW, displayName, orderContexts } from "../catalog";
  import { shownContexts } from "../hidden";
  import { contextSettings, settings } from "../stores/settings.svelte";
  import { live } from "../stores/live.svelte";
  import { openPalette, openSettings } from "../stores/keyboard.svelte";
  import { calmFor, streakText } from "../watch";
  import { scope, watch } from "../stores/watch.svelte";
  import WatchPanel from "./WatchPanel.svelte";
  import { disconnectNode, showNode, tree } from "../stores/clusters.svelte";

  /** The other clusters this window is connected to: at most three chips. */
  const CHIPS_MAX = 3;
  const others = $derived(
    [...tree.nodes.entries()].filter(([id, n]) => id !== current && n.state === "connected").map(([id]) => id),
  );
  import { confirmDiscard } from "../stores/unsaved.svelte";
  import { isMacPlatform, shortcutHint } from "../keys";
  import HelpMenu from "./HelpMenu.svelte";
  import NotificationBell from "./NotificationBell.svelte";
  import ModeBadge from "./ModeBadge.svelte";
  import { contextMode, contextNameOf } from "../stores/contextMode.svelte";
  import { history } from "../stores/history.svelte";
  import { goBack, goForward } from "../stores/navigation.svelte";

  const REFRESH_SHORTCUT = shortcutHint("refresh", isMacPlatform());
  const PALETTE_SHORTCUT = shortcutHint("palette", isMacPlatform());
  // The watch dial: the calm streak as of the last Overview update.
  const calm = $derived(watch.log.calmSince !== null);
  const dial = $derived(
    calm ? `calm ${streakText(calmFor(watch.log, watch.log.lastSeen))}` : `${scope.blips.length || ""} to look at`.trim(),
  );
  const BACK_SHORTCUT = shortcutHint("back", isMacPlatform());
  const FORWARD_SHORTCUT = shortcutHint("forward", isMacPlatform());

  async function onContextChange(select: HTMLSelectElement) {
    const name = select.value;
    if (!(await confirmDiscard())) {
      select.value = current;
      return;
    }
    // The backend drops its watches on a context switch; stop ours first.
    live.stop();
    return switchContext(name);
  }

  const current = $derived(app.contexts.find((c) => c.current)?.name ?? "");
  // Pinned contexts first (#78), by their display names.
  // Hidden ones are left out (ADR 0007), except the one shown.
  const listed = $derived(shownContexts(app.contexts, settings.current.hidden_contexts, [current]));
  const ordered = $derived(orderContexts(listed, settings.current.favourites));
  const label = (id: string) => displayName({ name: id }, contextSettings(id));
  const color = $derived(contextSettings(current).color);
  const mode = $derived(contextMode(current));
  const band = $derived(color || (mode === "protected" ? "var(--red)" : mode === "readOnly" ? "var(--amber)" : ""));
  /** Bumped per click: the icon turns once per refresh, never idles. */
  let spins = $state(0);
</script>

<!-- The cluster's own colour runs along the top of the window, so no screen
     of a production cluster looks like a screen of a test one. A protected
     or read-only context without a colour still gets a band. -->
<header
  class:banded={!!band}
  style:--band={band || null}
  data-testid="cluster-band"
  data-band={mode === "protected" ? "protected" : mode === "readOnly" ? "read-only" : color ? "colour" : "none"}
>
  <div class="brand">
    <!-- The mark: a sonar scope, its beam resting at the bearing of the
         last change. -->
    <svg class="mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" />
      <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" />
      <path d="M12 12 L19.07 4.93 A10 10 0 0 1 22 12 Z" fill="currentColor" fill-opacity="0.28" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="17.2" cy="8.4" r="1.4" fill="var(--brass)" />
    </svg>
    <span class="word">nauvi</span>
  </div>
  <div class="history" role="group" aria-label="History">
    <button
      class="arrow"
      type="button"
      aria-label="Go back"
      title={`Back (${BACK_SHORTCUT})`}
      disabled={!history.canBack}
      onclick={goBack}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
      </svg>
    </button>
    <button
      class="arrow"
      type="button"
      aria-label="Go forward"
      title={`Forward (${FORWARD_SHORTCUT})`}
      disabled={!history.canForward}
      onclick={goForward}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M4 13h12.17l-5.59 5.59L12 20l8-8-8-8-1.41 1.41L16.17 11H4v2z" />
      </svg>
    </button>
  </div>
  <div class="cluster" class:ok={app.status.ok === true} class:error={app.status.ok === false}>
    <span class="dot" class:ok={app.status.ok === true} class:error={app.status.ok === false} aria-hidden="true">
      <!-- One ring per change of state, then still. -->
      {#key app.status.text}<span class="ping"></span>{/key}
    </span>
    <span data-testid="connection-status">{app.status.text}</span>
  </div>
  {#if color}
    <span class="swatch" style:background={color} data-testid="context-color" aria-hidden="true"></span>
  {/if}
  <select
    class="select"
    class:invisible={listed.length <= 1}
    aria-label="Cluster context"
    value={current}
    onchange={(e) => onContextChange(e.currentTarget)}
  >
    {#if ordered.pinned.length > 0}
      <optgroup label="Pinned">
        {#each ordered.pinned as ctx (ctx.name)}
          <option value={ctx.name}>{label(ctx.name)}</option>
        {/each}
      </optgroup>
      <optgroup label="All clusters">
        {#each ordered.others as ctx (ctx.name)}
          <option value={ctx.name}>{label(ctx.name)}</option>
        {/each}
      </optgroup>
    {:else}
      {#each listed as ctx (ctx.name)}
        <option value={ctx.name}>{label(ctx.name)}</option>
      {/each}
    {/if}
  </select>
  {#each others.slice(0, CHIPS_MAX) as id (id)}
    <span class="chip" data-testid="cluster-chip">
      <button type="button" class="chip-go" title={`Show ${label(id)} in this window`} onclick={() => void showNode(id)}>
        <span class="chip-dot" style:background={contextSettings(id).color || null} aria-hidden="true"></span>
        {label(id)}
      </button>
      <button
        type="button"
        class="chip-x"
        aria-label={`Disconnect ${label(id)}`}
        title="Disconnect: stops its logs, terminals and forwards in this window"
        onclick={() => void disconnectNode(id)}>✕</button
      >
    </span>
  {/each}
  {#if others.length > CHIPS_MAX}
    <span class="chip more" title={others.slice(CHIPS_MAX).map(label).join(", ")}>+{others.length - CHIPS_MAX}</span>
  {/if}
  <ModeBadge {mode} name={contextNameOf(current)} />
  <button
    class="new-window"
    class:active={app.view === CATALOG_VIEW}
    type="button"
    title="Cluster catalog: every kubeconfig context, with its status"
    aria-label="Cluster catalog"
    onclick={() => setView(CATALOG_VIEW)}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h8v8h-8v-8zm2 2v4h4v-4h-4z" />
    </svg>
  </button>
  {#if app.contexts.length > 0}
    <button
      class="new-window"
      type="button"
      title="Open this context in a new window"
      aria-label="Open in new window"
      data-testid="open-in-new-window"
      onclick={() => openContextWindow(current)}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M14 3h7v7h-2V6.41l-8.29 8.3-1.42-1.42 8.3-8.29H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
        />
      </svg>
    </button>
  {/if}
  <button
    class="goto"
    type="button"
    title={`Go anywhere: kinds, objects, actions, namespaces (${PALETTE_SHORTCUT})`}
    aria-label="Go to"
    data-testid="rail-goto"
    onclick={() => openPalette()}
  >
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M16 16l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    <span class="hint">Go to a kind, an object, an action…</span>
    <kbd>{PALETTE_SHORTCUT.split(" or ")[0]}</kbd>
  </button>
  {#if watch.context}
    <button
      type="button"
      class="dial"
      class:calm
      aria-label="Watch"
      aria-expanded={watch.panel}
      title={calm ? `Calm on deck for ${dial}. Open the watch.` : "The deck is busy: the calm streak waits. Open the watch."}
      data-testid="watch-dial"
      onclick={() => (watch.panel = !watch.panel)}
    >
      <!-- A sonar the size of a letter: a blip per problem, a ring per change. -->
      <svg class="mini" viewBox="-10 -10 20 20" width="18" height="18" aria-hidden="true">
        <circle r="9" />
        <circle r="4.5" />
        {#each scope.blips.slice(0, 6) as b (b.key)}
          <circle class="blip {b.tone}" cx={(b.x / 92) * 9} cy={(b.y / 92) * 9} r="1.6" />
        {/each}
        {#key scope.sweep}<circle class="ring" r="9" />{/key}
        <circle class="hub" r="1.3" />
      </svg>
      {dial}
    </button>
    {#if watch.panel}<WatchPanel />{/if}
  {/if}
  <button
    class="refresh"
    type="button"
    title={`Refresh (${REFRESH_SHORTCUT})`}
    onclick={() => {
      spins++;
      refresh();
    }}
  >
    {#key spins}
      <svg class="turn" class:spun={spins > 0} viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
        <path
          fill="currentColor"
          d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
        />
      </svg>
    {/key}
    <span class="sr">Refresh</span>
  </button>
  <NotificationBell />
  <HelpMenu />
  <button class="gear" type="button" aria-label="Settings" title="Settings" onclick={openSettings}>
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  </button>
</header>

<style>
  header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    height: 40px;
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  /* The horizon: a hairline of teal fading out from the mark. */
  header::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), transparent 38%);
    pointer-events: none;
  }
  header.banded {
    box-shadow: inset 0 3px 0 var(--band);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
  }
  .word {
    font-family: var(--font-num);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.04em;
    color: var(--text);
  }
  .history {
    display: flex;
    gap: 2px;
    margin-left: -6px;
  }
  .arrow {
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
  }
  .arrow:hover:not(:disabled) {
    color: var(--text);
    background: var(--bg-hover);
  }
  .arrow:disabled {
    opacity: 0.35;
    cursor: default;
  }
  /* The connection, as a pill: its colour is the state, its ring the change. */
  .cluster {
    --state: var(--amber);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--state) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--state) 28%, transparent);
    transition:
      background-color 300ms ease,
      box-shadow 300ms ease;
  }
  .cluster.ok {
    --state: var(--green);
  }
  .cluster.error {
    --state: var(--red);
  }
  .dot {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--state);
    transition: background-color 300ms ease;
  }
  .ping {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid var(--state);
    animation: ping 1100ms var(--ease-out) both;
    pointer-events: none;
  }
  @keyframes ping {
    from {
      transform: scale(1);
      opacity: 0.9;
    }
    to {
      transform: scale(3.4);
      opacity: 0;
    }
  }
  .invisible {
    visibility: hidden;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: -10px;
  }
  /* Another connected cluster: one click shows it, the mark lets it go. */
  .chip {
    display: inline-flex;
    align-items: center;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted);
    margin-left: -6px;
  }
  .chip.more {
    padding: 0 8px;
    font-family: var(--font-num);
  }
  .chip button {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    height: 100%;
  }
  .chip-go {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 0 8px;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-go:hover {
    color: var(--text);
  }
  .chip-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    flex-shrink: 0;
  }
  .chip-x {
    padding: 0 6px;
    font-size: 9px;
    opacity: 0.6;
  }
  .chip-x:hover {
    opacity: 1;
    color: var(--red);
  }
  .new-window.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* Rarely used: quiet marks beside the picker, not boxed buttons. */
  .new-window {
    display: flex;
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 5px;
    margin-left: -8px;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 140ms ease;
  }
  .new-window:hover,
  .new-window:focus-visible,
  .new-window.active {
    opacity: 1;
  }
  .new-window:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  /* The way anywhere: the palette, as the rail's centre. */
  .goto {
    flex: 1;
    max-width: 420px;
    min-width: 120px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 8px 0 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: text;
    transition: border-color 140ms ease;
  }
  .goto:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .hint {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  kbd {
    font-family: var(--font-num);
    font-size: 10.5px;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .dial {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-num);
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px 2px 4px;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background-color 140ms ease;
  }
  .dial:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
    color: var(--text);
  }
  .mini {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 1;
  }
  .mini .hub {
    fill: var(--accent);
    stroke: none;
  }
  .mini .blip {
    fill: var(--amber);
    stroke: none;
  }
  .mini .blip.error {
    fill: var(--red);
  }
  .mini .ring {
    stroke: var(--accent);
    transform-box: fill-box;
    transform-origin: center;
    animation: dial-ring 1200ms var(--ease-out) both;
  }
  @keyframes dial-ring {
    from {
      transform: scale(0.2);
      opacity: 1;
    }
    to {
      transform: scale(1);
      opacity: 0;
    }
  }
  .dial.calm {
    color: var(--accent);
  }
  .refresh {
    position: relative;
    display: inline-flex;
    align-items: center;
    background: transparent;
    color: var(--text-muted);
    border: none;
    border-radius: 6px;
    padding: 6px;
    cursor: pointer;
    transition:
      color 140ms ease,
      background-color 140ms ease,
      transform 140ms var(--ease-out);
  }
  .refresh:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .refresh:active {
    transform: scale(0.97);
  }
  /* Read, not drawn: the button's name, for assistive tools and scripts. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .turn.spun {
    animation: turn 600ms var(--ease-out);
  }
  @keyframes turn {
    from {
      transform: rotate(-200deg);
    }
  }
  .gear {
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
  }
  .gear:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
</style>
