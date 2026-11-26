<script lang="ts">
  import { addSource, pasteKubeconfig } from "../../stores/catalog.svelte";

  /** Add a kubeconfig source: a file or folder by path, or pasted YAML.
   *  `cancel`: show Cancel (not on the welcome screen, where it stays, #485). */
  let { onclose, cancel = true }: { onclose: () => void; cancel?: boolean } = $props();

  let mode = $state<"path" | "paste">("path");
  let path = $state("");
  let yaml = $state("");
  let name = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    const ok = mode === "path" ? await addSource(path) : await pasteKubeconfig(yaml, name);
    busy = false;
    if (ok) onclose();
  }

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<form class="add" aria-label="Add kubeconfig" onsubmit={submit}>
  <div class="choices" role="radiogroup" aria-label="Add from">
    <label><input type="radio" name="mode" value="path" bind:group={mode} /> File or folder</label>
    <label><input type="radio" name="mode" value="paste" bind:group={mode} /> Paste a kubeconfig</label>
  </div>
  {#if mode === "path"}
    <input
      class="input path"
      aria-label="Kubeconfig file or folder"
      placeholder="~/.kube/work.yaml or ~/.kube/clusters/"
      spellcheck="false"
      bind:value={path}
      use:focus
    />
    <p class="muted hint">
      A folder brings in every kubeconfig file in it, including files added to it later. nauvi only reads them.
    </p>
  {:else}
    <textarea
      class="input yaml"
      aria-label="Kubeconfig YAML"
      placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: …"
      spellcheck="false"
      rows="10"
      bind:value={yaml}
      use:focus
    ></textarea>
    <input class="input" aria-label="Name (optional)" placeholder="Name (optional)" spellcheck="false" bind:value={name} />
    <p class="muted hint">
      Saved in nauvi's config folder, readable only by you. Removing it from the catalog deletes that copy.
    </p>
  {/if}
  <div class="buttons">
    <button
      type="submit"
      class="btn primary"
      disabled={busy || (mode === "path" ? !path.trim() : !yaml.trim())}>{mode === "path" ? "Add" : "Save and add"}</button
    >
    {#if cancel}<button type="button" class="btn" onclick={onclose}>Cancel</button>{/if}
  </div>
</form>

<style>
  .add {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }
  .choices {
    display: flex;
    gap: 16px;
  }
  .path {
    width: min(520px, 100%);
  }
  .yaml {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    resize: vertical;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
</style>
