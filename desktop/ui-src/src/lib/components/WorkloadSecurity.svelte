<script lang="ts">
  import type { WorkloadImage } from "../imageFindings";
  import { imageLine, sourcesText } from "../imageFindings";
  import { sourceText, verdict } from "../imageSecurity";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { openImageFindings } from "../stores/imageFindings.svelte";

  /** The Security tab of a workload (#535): what the image security
   *  listing says about each image it runs, worst first. Only the listing
   *  the app holds: the fixes by package are in the Image security view,
   *  which reads the full report when it shows one. */
  let { images }: { images: readonly WorkloadImage[] } = $props();

  const s = $derived(imageSecuritySettings());
  const now = Math.floor(Date.now() / 1000);
</script>

<div class="security" data-testid="workload-security">
  <p class="muted lead">
    From {sourcesText(images.map((w) => w.row), "the Trivy Operator's VulnerabilityReports")}. A vulnerability is not an outage: nothing here counts as a problem.
  </p>
  <ul>
    {#each images as w (w.row.image + w.row.digest)}
      {@const v = verdict(w.row, s)}
      {@const src = sourceText(w.row, now)}
      <li data-testid="workload-security-image" data-tone={v.tone} aria-label={imageLine(w, s)}>
        <div class="image mono" title={w.row.digest ? `${w.row.image}\n${w.row.digest}` : w.row.image}>{w.row.image}</div>
        <div class="muted small">{w.containers.length === 1 ? "Container" : "Containers"} {w.containers.join(", ")}</div>
        <p class="verdict {v.tone}" data-testid="workload-security-verdict">{v.text}</p>
        <div class="foot">
          <span class="muted small" class:stale={src.stale}
            >{src.text}{#if src.stale}{" · "}old scan{/if}</span
          >
          {#if w.row.scanned}
            <button type="button" class="link" onclick={() => openImageFindings(w.row)}>Show fixes</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .security {
    padding: 12px 16px;
    font-size: 13px;
  }
  .lead {
    margin: 0 0 12px;
    font-size: 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  li {
    padding: 10px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card, 6px);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .image {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }
  .small {
    font-size: 12px;
  }
  .verdict {
    margin: 6px 0 2px;
    font-weight: 500;
    padding-left: 10px;
    border-left: 3px solid var(--border-strong, var(--border));
  }
  .verdict.critical {
    border-left-color: var(--red);
  }
  .verdict.high {
    border-left-color: var(--amber);
  }
  .foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .stale {
    color: var(--amber);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }
</style>
