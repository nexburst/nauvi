<script lang="ts">
  // Above a local terminal (#331): offers a kubectl that matches the
  // cluster when the setting is on and the user's is too far from it.
  // Downloads only on the button's click.
  import { onMount } from "svelte";
  import { api, visibleCluster } from "../cluster";
  import { offerState, type OfferState } from "../kubectlMatch";
  import { settings } from "../stores/settings.svelte";
  import { openLocalShell } from "../stores/localShell";

  /** The downloaded kubectl this shell uses (`""`: the user's own). */
  let { used }: { used: string } = $props();

  let offer = $state.raw<OfferState>({ kind: "none" });
  let busy = $state(false);
  let error = $state("");
  let done = $state("");
  let dismissed = $state(false);

  onMount(async () => {
    if (!settings.current.kubectl_match) return;
    try {
      offer = offerState(await api(visibleCluster()).cmdKubectlMatch(), used);
    } catch (e) {
      offer = { kind: "note", text: `No matching kubectl to offer: ${e}` };
    }
  });

  async function download() {
    busy = true;
    error = "";
    try {
      const m = await api(visibleCluster()).cmdKubectlDownload();
      done = `kubectl ${m.server} was downloaded and its SHA-256 checked. New local terminals use it.`;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if offer.kind !== "none" && !dismissed}
  <div class="offer" class:fail={!!error} data-testid="kubectl-offer" role={error ? "alert" : "status"}>
    <span class="text">
      {#if done}
        {done}
      {:else if busy}
        Downloading kubectl {offer.kind === "offer" ? offer.version : ""} from dl.k8s.io and checking its SHA-256…
      {:else if error}
        {error}
      {:else}
        {offer.text}
        {#if offer.kind === "offer"}<span class="url" title={offer.url}>{offer.url}</span>{/if}
      {/if}
    </span>
    <span class="buttons">
      {#if done || offer.kind === "ready"}
        <button type="button" class="btn" onclick={() => openLocalShell()}>Open a new local terminal</button>
      {:else if offer.kind === "offer"}
        <button type="button" class="btn primary" disabled={busy} onclick={download}>
          {error ? "Try again" : `Download kubectl ${offer.version}`}
        </button>
      {/if}
      <button type="button" class="x" aria-label="Dismiss" onclick={() => (dismissed = true)}>✕</button>
    </span>
  </div>
{/if}

<style>
  .offer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    padding: 6px 10px;
    /* On the terminal's own dark background, in both themes. */
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    font-size: 12px;
    color: #d7dde3;
  }
  .offer.fail {
    background: rgba(229, 72, 77, 0.18);
    border-color: #e5484d;
    color: #ffb3b5;
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .url {
    display: block;
    color: #8b949e;
    font-family: monospace;
    font-size: 11px;
  }
  .buttons {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    align-items: center;
  }
  .x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
  }
</style>
