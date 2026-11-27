<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { ContainerImage, ResourceDetail } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import type { Target } from "../stores/detail.svelte";
  import AvailableTags from "./AvailableTags.svelte";

  /** The images of a workload's pod template, each with Available tags
   *  (#539). Shown only with the setting on (the parent checks). There is no
   *  running `imageID` here, so whether a tag was pushed again is only said
   *  in the pod panel. `info` is the panel's live detail: when it changes
   *  (a rollout to a new image, say), the images are read again. */
  let { target, info }: { target: Target; info: ResourceDetail | null } = $props();

  let images = $state.raw<ContainerImage[]>([]);
  let error = $state("");

  /** Wait this long after a change before reading again, like LiveRelated. */
  const DEBOUNCE_MS = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** The last detail seen, as JSON. */
  let lastDetail = "";

  async function load() {
    try {
      const next = await api(visibleCluster()).cmdWorkloadImages(target.resource, target.namespace, target.name);
      if (stopped) return;
      error = "";
      // Keep the list (and the open boxes) when nothing changed.
      if (JSON.stringify(next) !== JSON.stringify(images)) images = next;
    } catch (e) {
      if (!stopped) error = String(e);
    }
  }

  onMount(load);
  onDestroy(() => {
    stopped = true;
    clearTimeout(timer);
  });

  $effect(() => {
    if (!info) return;
    const key = JSON.stringify(info);
    untrack(() => {
      if (lastDetail === "") {
        lastDetail = key;
        return;
      }
      if (key === lastDetail) return;
      lastDetail = key;
      clearTimeout(timer);
      timer = setTimeout(load, DEBOUNCE_MS);
    });
  });
</script>

{#if error}
  <section data-testid="workload-images">
    <h3>Images</h3>
    <p class="error-text">Could not read the images: {error}</p>
  </section>
{:else if images.length > 0}
  <section data-testid="workload-images">
    <h3>Images</h3>
    <dl>
      <!-- Keyed by the image too: a new image gets a new box, not the old answer. -->
      {#each images as img (img.kind + "/" + img.container + "@" + img.image)}
        <dt title={img.kind === "init" ? "init container" : undefined}>
          {img.container}{#if img.kind === "init"}<span class="muted"> (init)</span>{/if}
        </dt>
        <dd>
          <div class="mono image" title={img.image}>{img.image}</div>
          <AvailableTags image={img.image} label={img.container} />
        </dd>
      {/each}
    </dl>
  </section>
{/if}

<style>
  section {
    font-size: 12px;
  }
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(60px, max-content) minmax(0, 1fr);
    gap: 4px 10px;
    margin: 0;
  }
  dt {
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  .image {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
