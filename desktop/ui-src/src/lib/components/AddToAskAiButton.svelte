<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import type { AiObject } from "../askAi";
  import { oneLine } from "../askAi";
  import { addToAiContext, aiContextRefused } from "../stores/aiContext.svelte";

  /** "Add to Ask AI" on a Problem group or Warning group row (#608): puts
   *  `object` in the AI context list. Refused (greyed, the reason in its
   *  tooltip) when it is already there or the list is full. */
  let { object }: { object: AiObject } = $props();

  const who = $derived(`${oneLine(object.kind)} ${object.namespace ? `${oneLine(object.namespace)}/` : ""}${oneLine(object.name)}`);
  const refused = $derived(aiContextRefused(object));
</script>

<button
  type="button"
  class="row-act add"
  class:denied={!!refused}
  data-testid="add-to-ask-ai"
  aria-label={`Add ${who} to Ask AI`}
  aria-disabled={refused ? "true" : undefined}
  title={refused || `Add ${who} to the Ask AI list, to ask about several objects together`}
  onclick={() => {
    if (!refused) addToAiContext(object);
  }}
>
  <Icon name="plus" size={14} />
</button>

<style>
  .add {
    padding: 0 5px;
  }
  .add.denied {
    opacity: 0.45;
    cursor: default;
  }
  .add.denied:hover {
    color: var(--text-muted);
    border-color: transparent;
    background: transparent;
  }
</style>
