<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { keyboard } from "../stores/keyboard.svelte";
  import { kinds, openObject, setView } from "../stores/app.svelte";
  import { openDockTab } from "../stores/dock.svelte";
  import { scope, watch } from "../stores/watch.svelte";
  import { problemLine } from "../problemPill";
  import { problemTone } from "../sonar";
  import Icon from "../icons/Icon.svelte";
  import Sonar from "./Sonar.svelte";
  import WatchLog from "./WatchLog.svelte";

  // As of opening: the streak is read, not watched tick by tick.
  const now = Date.now();
  const podKind = $derived(kinds.all.find((k) => k.id === "v1/pods"));
  const more = $derived(scope.total - scope.problems.length);

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
      onclick={() => (watch.tab = "problems")}>Problem pods{scope.total > 0 ? ` (${scope.total})` : ""}</button
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
      {#each scope.problems as p (p.namespace + "/" + p.name)}
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
    </div>
    <div class="foot">
      <button type="button" class="btn" data-testid="watch-overview" onclick={overview}>Show on the Overview</button>
    </div>
  {:else}
    <div class="log">
      <div class="scope">
        <Sonar blips={scope.blips} recovered={scope.recovered} healthy={scope.healthy} sweep={scope.sweep} />
      </div>
      <WatchLog {now} />
    </div>
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
