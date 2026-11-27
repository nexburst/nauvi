<script lang="ts">
  import type { ImageSecuritySettings_Serialize as ImageSecuritySettings, Severity } from "../bindings";
  import { CACHE_TTL_CHOICES, cacheTtlLabel, MIN_SEVERITIES } from "../imageSecurity";
  import { imageSecurityEnabled, imageSecuritySettings, reloadDetail } from "../stores/imageSecurity.svelte";
  import { updateSettings } from "../stores/settings.svelte";
  import { currentContextName } from "../stores/app.svelte";
  import { contextLabel, openClusterSettings } from "../stores/catalog.svelte";
  import { closeSettings } from "../stores/keyboard.svelte";
  import { parseNamespaceList } from "../catalog";
  import ImageScannerSettings from "./ImageScannerSettings.svelte";

  /** Settings → Image security (#534, ADR 0011). Off by default; each
   *  cluster can turn it on or off for itself in its cluster settings. */
  const s = $derived(imageSecuritySettings());
  const context = currentContextName();
  // svelte-ignore state_referenced_locally
  let excluded = $state(s.excluded_namespaces.join(", "));

  async function save(change: Partial<ImageSecuritySettings>) {
    await updateSettings({ image_security: { ...imageSecuritySettings(), ...change } });
    if ("min_severity" in change || "only_fixable" in change) reloadDetail();
  }
</script>

<fieldset data-testid="image-security-settings">
  <legend>Image security</legend>
  <label class="choice">
    <input
      type="checkbox"
      aria-label="Show image vulnerabilities"
      checked={s.enabled}
      onchange={(e) => save({ enabled: e.currentTarget.checked })}
    />
    Show image vulnerabilities from the Trivy Operator
  </label>
  <p class="muted hint">
    Off unless you turn it on. nauvi then reads the VulnerabilityReports the Trivy Operator keeps in the cluster, with
    your own access, only while the Image security view is open. It scans nothing and downloads nothing itself.
  </p>
  {#if context}
    <div class="row">
      <span class="muted status" data-testid="image-security-cluster-state">
        {contextLabel(context)}: {imageSecurityEnabled(context) ? "on" : "off"}
      </span>
      <button
        type="button"
        class="btn"
        onclick={() => {
          closeSettings();
          openClusterSettings(context);
        }}>Settings for {contextLabel(context)}…</button
      >
    </div>
  {/if}
  <label class="row">
    <span>Count</span>
    <select
      class="select"
      aria-label="Least severity to count"
      value={s.min_severity}
      onchange={(e) => save({ min_severity: e.currentTarget.value as Severity })}
    >
      {#each MIN_SEVERITIES as m (m.value)}
        <option value={m.value}>{m.label}</option>
      {/each}
    </select>
  </label>
  <label class="choice">
    <input
      type="checkbox"
      aria-label="Only vulnerabilities with a fix"
      checked={s.only_fixable}
      onchange={(e) => save({ only_fixable: e.currentTarget.checked })}
    />
    Only vulnerabilities that have a fix
  </label>
  <label class="row">
    <span>Leave out namespaces</span>
    <input
      class="input"
      aria-label="Namespaces to leave out"
      placeholder="kube-system, monitoring"
      spellcheck="false"
      bind:value={excluded}
      onchange={() => save({ excluded_namespaces: parseNamespaceList(excluded) })}
    />
  </label>
  <label class="row">
    <span>Read the reports again after</span>
    <select
      class="select"
      aria-label="Read the reports again after"
      value={String(s.cache_ttl_hours)}
      onchange={(e) => save({ cache_ttl_hours: Number(e.currentTarget.value) })}
    >
      {#each CACHE_TTL_CHOICES.includes(s.cache_ttl_hours) ? CACHE_TTL_CHOICES : [s.cache_ttl_hours, ...CACHE_TTL_CHOICES] as h (h)}
        <option value={String(h)}>{cacheTtlLabel(h)}</option>
      {/each}
    </select>
  </label>
  <p class="muted hint">
    Until then the view shows what it read last; Refresh reads the reports again. Images whose reports are more than 7
    days old are marked as old scans.
  </p>
  <ImageScannerSettings />
</fieldset>

<style>
  fieldset {
    border: none;
    padding: 0;
    margin: 16px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .choice,
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .row {
    justify-content: space-between;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .muted {
    color: var(--text-muted);
  }
  .status {
    font-size: 12px;
  }
  .input {
    width: 260px;
  }
</style>
