<script lang="ts">
  import { addRepo, charts, removeRepo, updateRepos } from "../../stores/helmCharts.svelte";

  /**
   * The chart repositories in the user's helm configuration: add, remove,
   * update. Shown in the Helm charts view and in Settings; the parent
   * loads them (`loadCharts`). `hint`: say so when there are none (the
   * Charts view's own empty state already does, #485).
   */
  let { hint = true }: { hint?: boolean } = $props();

  let name = $state("");
  let url = $state("");
  /** The repository whose Remove was clicked once (asks again). */
  let confirming = $state<string | null>(null);

  const canAdd = $derived(!charts.repoBusy && name.trim() !== "" && url.trim() !== "");

  async function add() {
    if (!canAdd) return;
    if (await addRepo(name.trim(), url.trim())) {
      name = "";
      url = "";
    }
  }

  async function remove(repo: string) {
    if (confirming !== repo) {
      confirming = repo;
      return;
    }
    confirming = null;
    await removeRepo(repo);
  }
</script>

<div class="repos" data-testid="helm-repos">
  {#if charts.reposError}
    <p class="error-text small" role="alert">{charts.reposError}</p>
  {/if}
  <ul aria-label="Chart repositories">
    {#each charts.repos as r (r.name)}
      <li data-testid="helm-repo">
        <span class="name">{r.name}</span>
        <span class="url muted" title={r.url}>{r.url}</span>
        <button type="button" class="btn small" disabled={charts.repoBusy} onclick={() => updateRepos([r.name])}
          >Update</button
        >
        <button
          type="button"
          class="btn small danger"
          disabled={charts.repoBusy}
          aria-label={confirming === r.name ? `Confirm removing ${r.name}` : `Remove ${r.name}`}
          onclick={() => remove(r.name)}>{confirming === r.name ? "Remove?" : "Remove"}</button
        >
      </li>
    {:else}
      {#if hint && charts.reposLoaded && !charts.reposError}
        <li class="muted">No chart repositories yet. Add one below, for example bitnami, https://charts.bitnami.com/bitnami.</li>
      {/if}
    {/each}
  </ul>
  {#each charts.repoWarnings as w (w)}
    <p class="warning small" data-testid="helm-repo-warning">{w}</p>
  {/each}
  <form
    class="add"
    onsubmit={(e) => {
      e.preventDefault();
      void add();
    }}
  >
    <input class="input" aria-label="Repository name" placeholder="name" spellcheck="false" bind:value={name} />
    <input
      class="input url-input"
      aria-label="Repository URL"
      placeholder="https://…"
      spellcheck="false"
      bind:value={url}
    />
    <button type="submit" class="btn" disabled={!canAdd}>{charts.repoBusy ? "Working…" : "Add"}</button>
    <button
      type="button"
      class="btn"
      disabled={charts.repoBusy || charts.repos.length === 0}
      title="Download the newest index of every repository"
      onclick={() => updateRepos()}>Update all</button
    >
  </form>
</div>

<style>
  .repos {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .url {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add .input {
    width: 110px;
  }
  .add .url-input {
    flex: 1;
    min-width: 120px;
  }
  .small {
    font-size: 12px;
    margin: 0;
  }
  .btn.small {
    padding: 2px 8px;
  }
  .btn.danger {
    border-color: var(--red);
    color: var(--red);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .warning {
    color: var(--amber);
  }
</style>
