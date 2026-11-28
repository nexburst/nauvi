<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import type { AskAiScope } from "../askAi";
  import { askAiOffered, openAskAi } from "../stores/askAi.svelte";
  import AddToAskAiButton from "./AddToAskAiButton.svelte";

  /** Ask AI on a row where a problem is (#607): a Problem group, a Warning
   *  group. Opens the dialog with a prompt about `scope` (names, the reason
   *  and counts only). Hidden without an AI CLI and on read-only contexts.
   *  Beside it, "Add to Ask AI" (#608) when the row names an object. */
  let { scope, about }: { scope: Omit<AskAiScope, "context">; about: string } = $props();
</script>

{#if askAiOffered()}
  <button
    type="button"
    class="row-act ai-action"
    data-testid="ask-ai-row"
    aria-label={`Ask AI about ${about}`}
    title={`Ask your AI CLI about ${about}, with the nauvi skill`}
    onclick={() => openAskAi(scope)}
  >
    <Icon name="sparkles" size={14} />Ask AI
  </button>
  {#if scope.kind && scope.name}
    <AddToAskAiButton object={{ namespace: scope.namespace, kind: scope.kind, name: scope.name, issue: scope.issue }} />
  {/if}
{/if}
