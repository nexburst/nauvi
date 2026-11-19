<script lang="ts">
  import { formatBinding, isMacPlatform, KEYMAP } from "../keys";
  import type { Binding } from "../keys";
  import { closeHelp } from "../stores/keyboard.svelte";

  /** `?`: every shortcut, generated from the keymap. */
  const mac = isMacPlatform();
  const groups = $derived.by(() => {
    const out = new Map<Binding["group"], Binding[]>();
    for (const b of KEYMAP) out.set(b.group, [...(out.get(b.group) ?? []), b]);
    return [...out.entries()];
  });

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && closeHelp()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="shortcut-help">
    <div class="head">
      <h2>Keyboard shortcuts</h2>
      <button type="button" class="x" title="Close (Esc)" use:focus onclick={closeHelp}><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg><span class="sr">Close</span></button>
    </div>
    <div class="columns">
    {#each groups as [group, bindings] (group)}
      <section>
      <h3>{group}</h3>
      <dl>
        {#each bindings as b (b.command)}
          <dt>
            {#each formatBinding(b, mac) as k, i (k)}
              {#if i > 0}<span class="or">or</span>{/if}<kbd>{k}</kbd>
            {/each}
          </dt>
          <dd>{b.label}</dd>
        {/each}
      </dl>
      </section>
    {/each}
    </div>
    <p class="muted note">Shortcuts are off while typing in a field, the YAML editor or the terminal.</p>
  </div>
</div>

<style>
  .x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 13px;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    cursor: pointer;
  }
  .x {
    position: relative;
  }
  .x svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .x:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: min(900px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow-y: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .columns {
    columns: 2 360px;
    column-gap: 36px;
  }
  .columns {
    margin-top: 12px;
  }
  section {
    break-inside: avoid;
    padding-bottom: 14px;
  }
  section h3 {
    margin-top: 0;
  }
  dl {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 6px 16px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  dd {
    margin: 0;
  }
  kbd {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
  }
  .or {
    color: var(--text-muted);
    font-size: 11px;
  }
  .note {
    margin: 14px 0 0;
    font-size: 12px;
  }
</style>
