<script lang="ts">
  // The Status cell of Deployments, StatefulSets and DaemonSets (#381): the
  // word in its tone, led by the container squares' shape for that tone
  // (#379), so Failed, Scaling and Running differ in shape as well as colour.
  import { rolloutLook, rolloutTone } from "../rolloutStatus";
  import StateGlyph from "./StateGlyph.svelte";

  let { word }: { word: string } = $props();
</script>

{#if word}
  <span class="rollout tone-{rolloutTone(word)}" data-testid="rollout-status" data-look={rolloutLook(word)}>
    <StateGlyph look={rolloutLook(word)} />
    <span class="word">{word}</span>
  </span>
{/if}

<style>
  .rollout {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    vertical-align: middle;
  }
  .word {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tone-ok {
    color: var(--green);
  }
  .tone-warn {
    color: var(--amber);
  }
  .tone-bad {
    color: var(--red);
  }
  .tone-muted {
    color: var(--text-muted);
  }
</style>
