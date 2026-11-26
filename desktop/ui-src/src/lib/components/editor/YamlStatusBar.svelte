<script lang="ts">
  // The YAML editor's messages (#495), in one bar between its buttons and
  // the text: what is going on, whether the save worked, what it takes
  // over, and why it stopped. Above the editor, so they are in view
  // whatever the panel's height.
  import type { Snippet } from "svelte";
  import Icon from "../../icons/Icon.svelte";
  import type { FieldTakeover } from "../../bindings";
  import { managerLabel, toolList } from "../../editor/managers";

  let {
    progress = "",
    hint = "",
    savedAt = "",
    reviewing = false,
    rebased = [],
    overwrite = false,
    pendingTakeovers = [],
    takeovers = [],
    conflict = null,
    error = "",
    errorAt = null,
    conflictActions,
  }: {
    /** "Loading…", "Validating…", "Saving…". */
    progress?: string;
    /** A plain line when nothing else is shown (a locked Secret). */
    hint?: string;
    /** The time of the last save, shown until the next edit. */
    savedAt?: string;
    reviewing?: boolean;
    /** Fields the server changed that the edit was re-applied on top of. */
    rebased?: readonly string[];
    /** The diff is against a latest version that changed the same fields. */
    overwrite?: boolean;
    pendingTakeovers?: readonly FieldTakeover[];
    takeovers?: readonly FieldTakeover[];
    /** When the save stopped on a conflict: the fields both sides changed,
     *  or why the object is not the one loaded (`reason`). */
    conflict?: { fields: readonly string[]; reason: string } | null;
    error?: string;
    errorAt?: number | null;
    conflictActions: Snippet;
  } = $props();

  const filled = $derived(
    !!(progress || conflict || error || (reviewing && !progress) || savedAt || (hint && !progress && !error)),
  );

  const LIST_MAX = 4;
  function fields(list: readonly string[]): string {
    const shown = list.slice(0, LIST_MAX).join(", ");
    return list.length > LIST_MAX ? `${shown} and ${list.length - LIST_MAX} more` : shown;
  }
</script>

<div class="bar" class:filled data-testid="yaml-status" aria-live="polite">
  {#if progress}
    <p class="line muted">{progress}</p>
  {/if}

  {#if conflict}
    <div class="msg warn" role="alert">
      <Icon name="warning" size={14} />
      <div>
        {#if conflict.reason}
          {conflict.reason}
        {:else if conflict.fields.length > 0}
          You and someone else both changed <code>{fields(conflict.fields)}</code> since you loaded this object.
          Nothing was saved.
        {:else}
          This object changed on the server since you loaded it. Nothing was saved.
        {/if}
        <div class="actions">{@render conflictActions()}</div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="msg bad" role="alert">
      <Icon name="error" size={14} />
      <div>
        {error}{#if errorAt !== null}<span class="muted"> (line {errorAt})</span>{/if}
      </div>
    </div>
  {/if}

  {#if reviewing && !progress}
    {#if rebased.length > 0}
      <div class="msg info" role="note" data-testid="yaml-rebased">
        <Icon name="refresh" size={14} />
        <div>
          The object changed on the server while you were editing (<code>{fields(rebased)}</code>). Your edits are
          now on top of the latest version: check them, then save.
        </div>
      </div>
    {/if}
    {#if overwrite}
      <div class="msg warn" role="note">
        <Icon name="warning" size={14} />
        <div>
          This compares your edits with the latest version. Saving replaces what changed there with your version
          of it.
        </div>
      </div>
    {/if}
    <p class="line">
      <Icon name="check" size={14} /> The server accepted these changes in a test run. Check them, then save.
    </p>
    {#if pendingTakeovers.length > 0}
      {@render takeoverNote(pendingTakeovers, false)}
    {/if}
  {/if}

  {#if savedAt}
    <p class="line ok" role="status" data-testid="yaml-saved">
      <Icon name="ok" size={14} /> Saved at {savedAt}.
    </p>
    {#if takeovers.length > 0}
      {@render takeoverNote(takeovers, true)}
    {/if}
  {/if}

  {#if hint && !progress && !error}
    <p class="line muted">{hint}</p>
  {/if}
</div>

{#snippet takeoverNote(list: readonly FieldTakeover[], done: boolean)}
  {@const tools = toolList(list.map((t) => t.manager))}
  <div class="msg warn" role="note">
    <Icon name="warning" size={14} />
    <div>
      {#if done}
        This save took over fields that {tools} had set. {tools} may set them back the next time it runs.
      {:else}
        Saving takes over fields that {tools} set. {tools} may set them back the next time it runs.
      {/if}
      <ul>
        {#each list as t (t.manager)}
          <li>
            <strong title={t.manager}>{managerLabel(t.manager)}</strong>:
            {#each t.fields as f, i (f)}<code>{f}</code>{i < t.fields.length - 1 ? ", " : ""}{/each}
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/snippet}

<style>
  .bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 16px;
    font-size: var(--text-sm);
  }
  .bar.filled {
    padding-bottom: 8px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .line.ok {
    color: var(--green);
    font-weight: 600;
  }
  .msg {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    word-break: break-word;
    max-height: 9.5em;
    overflow: auto;
  }
  .msg :global(.icon) {
    flex: none;
    margin-top: 2px;
  }
  .msg.warn {
    border-color: var(--amber);
  }
  .msg.warn > :global(.icon) {
    color: var(--amber);
  }
  .msg.bad {
    border-color: var(--red);
    color: var(--error-text);
  }
  .msg.info {
    border-color: var(--accent);
  }
  .msg.info > :global(.icon) {
    color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  code {
    font-family: var(--font-num);
    font-size: var(--text-xs);
    word-break: break-all;
  }
</style>
