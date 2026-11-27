<script lang="ts">
  import type { IgnoredVuln, IgnoreScope, ImageDetail } from "../bindings";
  import { EXPIRY_CHOICES, expiryText, makeRule, scopeChoices, scopeText } from "../imageTriage";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { addIgnore, removeIgnore } from "../stores/imageTriage.svelte";
  import { currentContextName } from "../stores/app.svelte";

  /** What an ignore covers in this image (counted, with its reason: never
   *  hidden silently), and the form that ignores one more (#537). */
  let { detail }: { detail: ImageDetail } = $props();

  const now = Math.floor(Date.now() / 1000);
  const ids = $derived([...new Set(detail.vulnerabilities.map((v) => v.id))]);
  const scopes = $derived(scopeChoices(detail.image));

  let id = $state("");
  let scope = $state<IgnoreScope>("image");
  let reason = $state("");
  let days = $state(90);
  let saving = $state(false);
  const chosen = $derived(ids.includes(id) ? id : (ids[0] ?? ""));
  const ready = $derived(!!chosen && reason.trim().length > 0 && !saving);

  async function ignore() {
    if (!ready) return;
    saving = true;
    try {
      await addIgnore(makeRule(chosen, scope, detail.image, reason, days, currentContextName() ?? "", now));
      reason = "";
      id = "";
    } finally {
      saving = false;
    }
  }

  /** nauvi's own ignore behind `i`, to remove it (a file's is changed in the file). */
  function ownRule(i: IgnoredVuln) {
    return imageSecuritySettings().ignores.find(
      (r) => r.id.toLowerCase() === i.vulnerability.id.toLowerCase() && r.reason === i.reason,
    );
  }
</script>

{#if detail.ignored.length > 0}
  <details class="ignored" data-testid="findings-ignored">
    <summary>Ignored ({detail.ignored.length}): not counted</summary>
    <ul>
      {#each detail.ignored as i (i.vulnerability.id + i.vulnerability.package + i.vulnerability.installed_version)}
        {@const own = ownRule(i)}
        <li>
          <span>
            <span class="mono">{i.vulnerability.id}</span>
            <span class="muted">{i.vulnerability.package} {i.vulnerability.installed_version}, {i.vulnerability.severity}</span>
          </span>
          <span class="muted"
            >{i.reason}{i.from_file ? " (ignore file)" : ""}{i.expires ? `, ${expiryText(i.expires, now)}` : ""}{#if own}
              {" "}in {scopeText(own)}{/if}</span
          >
          {#if own}
            <button type="button" class="link" onclick={() => removeIgnore(own)}>Stop ignoring</button>
          {/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}

{#if ids.length > 0}
  <details class="form" data-testid="ignore-form">
    <summary>Ignore a vulnerability…</summary>
    <div class="fields">
      <label>
        <span>Vulnerability</span>
        <select class="select" aria-label="Vulnerability to ignore" value={chosen} onchange={(e) => (id = e.currentTarget.value)}>
          {#each ids as x (x)}
            <option value={x}>{x}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>In</span>
        <select class="select" aria-label="Where to ignore it" bind:value={scope}>
          {#each scopes as c (c.scope)}
            <option value={c.scope}>{c.label}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Until</span>
        <select class="select" aria-label="How long to ignore it" bind:value={days}>
          {#each EXPIRY_CHOICES as c (c.days)}
            <option value={c.days}>{c.label}</option>
          {/each}
        </select>
      </label>
      <label class="wide">
        <span>Reason</span>
        <input
          class="input"
          aria-label="Why it is ignored"
          placeholder="Not reachable: the image never parses untrusted certificates"
          maxlength="300"
          bind:value={reason}
          onkeydown={(e) => e.key === "Enter" && ignore()}
        />
      </label>
      <div class="actions">
        <span class="muted">It stops counting here; the row says how many are ignored.</span>
        <button type="button" class="btn" disabled={!ready} onclick={ignore}>Ignore</button>
      </div>
    </div>
  </details>
{/if}

<style>
  details {
    margin: 12px 0 0;
  }
  summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    min-width: 0;
  }
  .fields label > span {
    color: var(--text-muted);
  }
  .fields .select,
  .fields .input {
    width: 100%;
    min-width: 0;
  }
  .wide,
  .actions {
    grid-column: 1 / -1;
  }
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .muted {
    color: var(--text-muted);
  }
  .link {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
</style>
