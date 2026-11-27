<script lang="ts">
  import { commands } from "../bindings";
  import type { TagReport } from "../bindings";
  import { countText, emptyText, imageRegistry, registryName, tagDay, tagSections, tagStateText } from "../registryTags";

  /** Available tags (#539): a button that asks the image's registry for
   *  its newer tags, grouped newer patch / minor / major (the variant kept),
   *  and says whether the running tag was pushed again since `imageId`.
   *  Only on the click; the backend caches the answer for ten minutes. */
  let { image, imageId = "", label = "" }: { image: string; imageId?: string; label?: string } = $props();

  let open = $state(false);
  let loading = $state(false);
  let error = $state("");
  let report = $state.raw<TagReport | null>(null);
  /** A newer request replaces the answer of an older one. */
  let seq = 0;

  const sections = $derived(report ? tagSections(report) : []);
  const stateLine = $derived(report ? tagStateText(report) : "");
  const empty = $derived(report ? emptyText(report) : "");
  const host = $derived(registryName(imageRegistry(image)));

  async function load(refresh: boolean) {
    const id = ++seq;
    open = true;
    loading = true;
    error = "";
    try {
      const r = await commands.cmdRegistryTags(image, imageId, refresh);
      if (id === seq) report = r;
    } catch (e) {
      if (id === seq) {
        error = String(e);
        report = null;
      }
    } finally {
      if (id === seq) loading = false;
    }
  }
</script>

<div class="available" data-testid="available-tags">
  {#if !open}
    <button
      type="button"
      class="btn small"
      aria-label={`Available tags of ${label || image}`}
      title={`Ask ${host} which newer tags it has`}
      onclick={() => load(false)}>Available tags</button
    >
  {:else}
    <div class="box" role="region" aria-label={`Available tags of ${label || image}`}>
      {#if loading}
        <p class="muted" data-testid="tags-loading">Asking {host}…</p>
      {:else if error}
        <p class="error-text" data-testid="tags-error">{error}</p>
      {:else if report}
        {#if stateLine}
          <p class="state state-{report.state}" data-testid="tags-state">{stateLine}</p>
        {/if}
        {#if empty}<p class="muted" data-testid="tags-empty">{empty}</p>{/if}
        {#each sections as s (s.id)}
          <div class="group" data-testid="tags-{s.id}">
            <div class="title">
              {s.title}{#if s.hint}<span class="muted">{` · ${s.hint}`}</span>{/if}
            </div>
            <ul>
              {#each s.group.tags as t (t.tag)}
                <li class="mono tag" title={t.updated ? `Pushed ${t.updated}` : undefined}>
                  {t.tag}{#if tagDay(t.updated)}{" "}<span class="muted day">{tagDay(t.updated)}</span>{/if}
                </li>
              {/each}
              {#if s.group.more > 0}<li class="muted">+{s.group.more} more</li>{/if}
            </ul>
          </div>
        {/each}
        <p class="muted foot" data-testid="tags-count">{countText(report)}</p>
      {/if}
      <div class="actions">
        {#if !loading}
          <button type="button" class="link" onclick={() => load(true)}>{error ? "Try again" : "Refresh"}</button>
        {/if}
        <button type="button" class="link" onclick={() => (open = false)}>Hide</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .available {
    min-width: 0;
  }
  .box {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    margin-top: 2px;
  }
  p {
    margin: 2px 0;
    overflow-wrap: anywhere;
  }
  .state-updated,
  .state-gone {
    color: var(--amber);
    font-weight: 600;
  }
  .state-unchanged {
    color: var(--green);
  }
  .group + .group,
  .state + .group {
    margin-top: 4px;
  }
  .title {
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .tag {
    overflow-wrap: anywhere;
  }
  .day {
    margin-left: 2px;
    font-family: inherit;
    font-size: 11px;
  }
  .foot {
    font-size: 11px;
  }
  .actions {
    display: flex;
    gap: 10px;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .btn.small {
    padding: 1px 8px;
    font-size: 11px;
  }
</style>
