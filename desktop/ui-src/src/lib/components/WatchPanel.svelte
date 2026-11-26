<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { keyboard } from "../stores/keyboard.svelte";
  import { currentContextName, kinds, openObject, setView } from "../stores/app.svelte";
  import { openDockTab } from "../stores/dock.svelte";
  import { problemsOf, scope, watch } from "../stores/watch.svelte";
  import { hhmmss, zoneSuffix } from "../timeZone";
  import { settings } from "../stores/settings.svelte";
  import { problemLine } from "../problemPill";
  import { problemTone } from "../sonar";
  import Icon from "../icons/Icon.svelte";
  import Sonar from "./Sonar.svelte";
  import WatchLog from "./WatchLog.svelte";

  // As of opening: the streak is read, not watched tick by tick.
  const now = Date.now();
  const podKind = $derived(kinds.all.find((k) => k.id === "v1/pods"));
  const context = $derived(currentContextName());
  /** The list, only if it is of the cluster on screen (#504). */
  const seen = $derived(problemsOf(context));
  const more = $derived(seen ? seen.total - seen.problems.length : 0);
  /** The watch log is of the cluster the Overview last watched. */
  const logOk = $derived(watch.context === context);
  const zone = $derived(settings.current.time_zone);

  function close() {
    watch.panel = false;
  }

  // Open, it handles its own keys (Esc closes it), like a menu.
  onMount(() => {
    keyboard.menus += 1;
  });
  onDestroy(() => {
    keyboard.menus -= 1;
  });
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function open(namespace: string, name: string) {
    close();
    if (podKind) openObject(podKind, namespace, name);
  }

  function logs(namespace: string, name: string) {
    close();
    if (podKind) openDockTab({ type: "podLogs", pod: { resource: podKind.resource, namespace, name } });
  }

  function overview() {
    close();
    setView("overview");
  }
</script>

<!-- Opened from the header pill (#491): first the problem pods it counts,
     each a link to the pod; the watch log (streak, insignia) is the second
     tab. -->
<svelte:window {onkeydown} />
<button type="button" class="scrim" aria-label="Close" tabindex="-1" onclick={close}></button>
<div class="panel" role="dialog" aria-label="Problem pods" data-testid="watch-panel">
  <div class="tabs" role="tablist" aria-label="Show">
    <button
      type="button"
      role="tab"
      class="tab"
      aria-selected={watch.tab === "problems"}
      data-testid="watch-tab-problems"
      onclick={() => (watch.tab = "problems")}>Problem pods{seen && seen.total > 0 ? ` (${seen.total})` : ""}</button
    >
    <button
      type="button"
      role="tab"
      class="tab"
      aria-selected={watch.tab === "log"}
      data-testid="watch-tab-log"
      title="How long the cluster stayed without problem pods, and the insignia"
      onclick={() => (watch.tab = "log")}>Watch log</button
    >
  </div>

  {#if watch.tab === "problems"}
    <div class="problems" data-testid="watch-problems">
      {#if !seen}
        <p class="none" data-testid="watch-not-counted">The Overview lists the problem pods of this cluster. Open it to see them.</p>
      {:else}
      {#each seen.problems as p (p.namespace + "/" + p.name)}
        {@const error = problemTone(p) === "error"}
        <div class="row" class:error data-testid="watch-problem">
          <Icon name={error ? "error" : "pending"} size={16} />
          <div class="what">
            <button
              type="button"
              class="name"
              title={`Open ${p.namespace}/${p.name}`}
              disabled={!podKind}
              onclick={() => open(p.namespace, p.name)}><span class="ns">{p.namespace}/</span>{p.name}</button
            >
            <span class="reason">{problemLine(p)}</span>
          </div>
          {#if podKind && p.status !== "Pending"}
            <button
              type="button"
              class="btn act"
              aria-label={`Logs of ${p.namespace}/${p.name}`}
              title={`Logs of ${p.namespace}/${p.name}`}
              onclick={() => logs(p.namespace, p.name)}><Icon name="logs" size={14} />Logs</button
            >
          {/if}
        </div>
      {:else}
        <p class="none">No pod needs a look right now.</p>
      {/each}
      {#if more > 0}<p class="none">And {more} more on the Overview.</p>{/if}
      {#if !seen.live}
        <p class="as-of" data-testid="watch-as-of">As of {hhmmss(seen.at, zone).slice(0, 5)}{zoneSuffix(zone)}, when the Overview was last open.</p>
      {/if}
      {/if}
    </div>
    <div class="foot">
      <button type="button" class="btn" class:primary={!seen} data-testid="watch-overview" onclick={overview}
        >{seen ? "Show on the Overview" : "Open the Overview"}</button
      >
    </div>
  {:else}
    {#if !logOk}
      <p class="none">The watch log of this cluster starts when the Overview is open.</p>
    {:else}
    <div class="log">
      <div class="scope">
        <Sonar blips={scope.blips} recovered={scope.recovered} healthy={scope.healthy} sweep={scope.sweep} />
      </div>
      <WatchLog {now} />
    </div>
    {/if}
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: transparent;
    border: none;
    cursor: default;
  }
  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 12px;
    z-index: 60;
    width: 460px;
    max-width: calc(100vw - 24px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 14px 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: var(--shadow-pop);
    transform-origin: top right;
    animation: open 180ms var(--ease-out);
  }
  @keyframes open {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-4px);
    }
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    padding: 4px 8px 6px;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab[aria-selected="true"] {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .problems {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 340px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 4px;
    border-radius: 4px;
    color: var(--amber);
  }
  .row.error {
    color: var(--red);
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
    color: var(--text);
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover:not(:disabled) {
    color: var(--accent);
    text-decoration: underline;
  }
  .ns {
    color: var(--text-muted);
    font-weight: 400;
  }
  .reason {
    font-size: var(--text-sm);
    color: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .none {
    margin: 6px 4px;
    color: var(--text-muted);
    font-size: var(--text-base);
  }
  .as-of {
    margin: 4px 4px 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
  }
  .log {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 18px;
    align-items: center;
    padding: 4px 2px;
  }
  .scope {
    aspect-ratio: 1;
  }
</style>
