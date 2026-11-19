<script lang="ts">
  import { scope, watch } from "../stores/watch.svelte";
  import Sonar from "./Sonar.svelte";
  import WatchLog from "./WatchLog.svelte";

  // As of opening: the streak is read, not watched tick by tick.
  const now = Date.now();
</script>

<!-- The watch, in one place: the sonar, the calm streak, the hours and the
     insignia. Opened from the rail's dial. -->
<button type="button" class="scrim" aria-label="Close the watch" tabindex="-1" onclick={() => (watch.panel = false)}></button>
<div class="panel" role="dialog" aria-label="Watch" data-testid="watch-panel">
  <div class="scope">
    <Sonar blips={scope.blips} recovered={scope.recovered} healthy={scope.healthy} sweep={scope.sweep} />
  </div>
  <WatchLog {now} />
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
    display: grid;
    grid-template-columns: 150px 270px;
    gap: 18px;
    align-items: center;
    padding: 16px 18px;
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
  .scope {
    aspect-ratio: 1;
  }
</style>
