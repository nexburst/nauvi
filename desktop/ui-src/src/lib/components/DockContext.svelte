<script lang="ts">
  import ClusterLabel from "./ClusterLabel.svelte";
  import { contextText } from "../dockContext";
  import type { ContextLink, ContextPart } from "../dockContext";
  import { app, currentContextName, kinds, openObject, setNamespaces } from "../stores/app.svelte";
  import { contextLabel } from "../stores/catalog.svelte";

  /** The line at the top of a dock tab (#386): what it is attached to. The
   *  names open their objects while the tab's cluster is the one shown. */
  let { parts, cluster }: { parts: ContextPart[]; cluster: string } = $props();

  const elsewhere = $derived(cluster !== "" && cluster !== currentContextName());
  const full = $derived(contextText(parts));

  function kindOf(l: ContextLink) {
    return kinds.all.find((k) => k.resource.group === l.group && k.resource.kind === l.kind);
  }

  function why(l: ContextLink): string {
    if (elsewhere) return `On ${contextLabel(cluster)}: switch to that cluster to open it`;
    return kindOf(l) ? `Open ${l.kind.toLowerCase()} ${l.name}` : `This cluster does not serve ${l.kind} objects`;
  }

  function open(l: ContextLink) {
    const kind = kindOf(l);
    if (!kind || elsewhere) return;
    const scope = app.selectedNamespaces;
    if (l.namespace && scope.length > 0 && !scope.includes(l.namespace)) setNamespaces([l.namespace]);
    openObject(kind, l.namespace, l.name);
  }
</script>

<div class="context" data-testid="dock-context" title={full}>
  <span class="text"
    >{#each parts as p, i (i)}{#if p.link}{@const l = p.link}<button
          type="button"
          class="link"
          class:code={p.code}
          disabled={elsewhere || !kindOf(l)}
          title={why(l)}
          onclick={() => open(l)}>{p.text}</button
        >{:else if p.code}<span class="code">{p.text}</span>{:else}{p.text}{/if}{/each}</span
  >
  {#if elsewhere}
    <span class="on">on <ClusterLabel id={cluster} title={`Runs on ${contextLabel(cluster)}`} /></span>
  {/if}
</div>

<style>
  .context {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 4px 16px;
    font-size: 12px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    white-space: nowrap;
  }
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .on {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    min-width: 0;
    max-width: 40%;
  }
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--text);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .link.code {
    color: var(--accent);
  }
  .link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .link:disabled {
    color: var(--text);
    cursor: default;
  }
</style>
