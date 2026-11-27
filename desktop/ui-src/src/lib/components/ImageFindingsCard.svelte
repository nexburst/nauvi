<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { headline, headlineDetail, IMAGE_SECURITY_VIEW, imageRows } from "../imageSecurity";
  import { overviewFindings } from "../imageFindings";
  import { setView } from "../stores/app.svelte";
  import { findingsImages, useFindings } from "../stores/imageFindings.svelte";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";

  /** The Overview's image security card (#535): how many images have a
   *  fix waiting, from the listing the app holds; it opens the Image
   *  security view. Not a problem card: never red, never in the headline.
   *  Nothing while image security is off or the listing has nothing. */

  useFindings();
  const images = $derived(findingsImages());
  const s = $derived(imageSecuritySettings());
  const f = $derived(images ? overviewFindings(images, s) : null);
  const title = $derived.by(() => {
    if (!images) return "";
    const rows = imageRows(images, s);
    return `${headline(rows)}. ${headlineDetail(rows, s)} Opens Image security.`;
  });
</script>

{#if f && f.images > 0}
  <button
    type="button"
    class="card tone-{f.waiting > 0 ? f.tone : 'neutral'}"
    class:zero={f.waiting === 0}
    data-testid="overview-image-findings"
    {title}
    onclick={() => setView(IMAGE_SECURITY_VIEW)}
  >
    <span class="label">Image fixes waiting</span>
    <span class="card-foot"><span class="num">{f.waiting}</span><Icon name="shield" size={18} /></span>
  </button>
{/if}

<style>
  /* As the Overview's stat cards (Overview.svelte). */
  .card {
    --tone: var(--text-muted);
    min-width: 0;
    padding: 10px 12px 11px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .card:hover {
    border-color: var(--border-strong, var(--border));
  }
  .card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* Amber at most: a vulnerability with a fix is work, not an outage. */
  .card.tone-critical,
  .card.tone-high {
    --tone: var(--amber);
  }
  .card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-top: 4px;
    color: var(--tone);
  }
  .card.zero .card-foot {
    color: var(--text-muted);
  }
  .label {
    display: block;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .num {
    font-size: 24px;
    color: var(--text);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .card.zero .num {
    color: var(--text-muted);
    opacity: 0.55;
  }
</style>
