<script lang="ts" module>
  import type { Edit } from "../dataEdit";

  /** Edits kept while the editor is unmounted (the panel's YAML tab), until
   *  saved or discarded; the unsaved-edit guard asks before dropping them.
   *  Only the edits: revealed values are never kept. */
  interface Draft {
    edits: Map<string, Edit>;
    resourceVersion: string;
  }
  const drafts = new Map<string, Draft>();
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { commands } from "../bindings";
  import type { DataEncoding, DataEntry, RevealedValue } from "../bindings";
  import { changesOf, isBase64, keyError, sizeText, summaryOf, withValue } from "../dataEdit";
  import type { Target } from "../stores/detail.svelte";
  import { confirmDiscard, markSaved, markUnsaved } from "../stores/unsaved.svelte";

  /** The keys of a Secret or ConfigMap (#224): reveal (Secrets), copy, edit,
   *  add and remove keys, saved as a merge patch of the changed keys only.
   *  Secret values are fetched one key at a time on an explicit Reveal,
   *  Copy or Edit, and live only in this component. */
  let { target, disabled = false }: { target: Target; disabled?: boolean } = $props();

  // The panel is remounted for every object, so `target` is fixed here.
  // svelte-ignore state_referenced_locally
  const isSecret = target.resource.group === "" && target.resource.kind === "Secret";
  // svelte-ignore state_referenced_locally
  const id = `data|${target.resource.group}/${target.resource.kind}|${target.namespace}/${target.name}`;
  const what = isSecret ? "Secret" : "ConfigMap";

  let entries = $state.raw<DataEntry[]>([]);
  let resourceVersion = $state("");
  let immutable = $state(false);
  let loaded = $state(false);
  let loadError = $state("");
  /** Secret values the user revealed, by key. Dropped on destroy. */
  let revealed = $state.raw(new Map<string, RevealedValue>());
  /** Pending edits by key. */
  let edits = $state.raw(new Map<string, Edit>());
  /** Keys whose value is open for editing. */
  let editing = $state.raw(new Set<string>());
  let busy = $state(false);
  let status = $state("");
  let error = $state("");
  let conflict = $state(false);
  /** Why editing is not allowed (RBAC), empty if it is. */
  let denied = $state("");
  /** The "Add key" form. */
  let adding = $state(false);
  let newKey = $state("");
  let newValue = $state("");

  const dirty = $derived(edits.size > 0);
  const readOnly = $derived(disabled || immutable || !!denied);
  const readOnlyReason = $derived(
    disabled ? "" : immutable ? `This ${what} is immutable: its data cannot change.` : denied,
  );

  $effect(() => {
    if (dirty) markUnsaved(id, discardEdits);
    else markSaved(id);
  });

  function discardEdits() {
    drafts.delete(id);
    edits = new Map();
    editing = new Set();
    adding = false;
    newKey = newValue = "";
  }

  async function load() {
    loadError = "";
    try {
      const d = await commands.cmdGetDataEntries(target.resource, target.namespace, target.name);
      entries = d.entries;
      resourceVersion = d.resource_version;
      immutable = d.immutable;
      // Revealed values of keys that are gone, or changed size, are dropped.
      const next = new Map<string, RevealedValue>();
      for (const e of d.entries) {
        const v = revealed.get(e.key);
        if (v) next.set(e.key, v);
      }
      revealed = next;
      loaded = true;
    } catch (e) {
      loadError = String(e);
    }
  }

  function clearMessages() {
    status = "";
    error = "";
    conflict = false;
  }

  /** The value of `e` to show and edit: text, or base64 if binary. */
  function shown(e: DataEntry): RevealedValue | null {
    if (!e.hidden) return { value: e.value, binary: e.binary };
    return revealed.get(e.key) ?? null;
  }

  async function fetchValue(e: DataEntry): Promise<RevealedValue | null> {
    const known = shown(e);
    if (known) return known;
    try {
      return await commands.cmdRevealDataValue(target.resource, target.namespace, target.name, e.key);
    } catch (err) {
      error = `Could not read "${e.key}": ${err}`;
      return null;
    }
  }

  async function reveal(e: DataEntry) {
    clearMessages();
    const v = await fetchValue(e);
    if (v) revealed = new Map(revealed).set(e.key, v);
  }

  function hide(key: string) {
    const next = new Map(revealed);
    next.delete(key);
    revealed = next;
    if (editing.has(key) && !edits.has(key)) {
      const ed = new Set(editing);
      ed.delete(key);
      editing = ed;
    }
  }

  function hideAll() {
    revealed = new Map();
    editing = new Set([...editing].filter((k) => edits.has(k)));
  }

  /** Copies only on this explicit click; a hidden value is read for it but
   *  stays hidden on screen. */
  async function copy(e: DataEntry) {
    clearMessages();
    const pending = edits.get(e.key);
    const v = pending && !pending.delete ? { value: pending.value } : await fetchValue(e);
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v.value);
      status = `Copied the value of "${e.key}".`;
    } catch {
      error = "Could not copy to the clipboard.";
    }
  }

  async function startEdit(e: DataEntry) {
    clearMessages();
    const v = await fetchValue(e);
    if (!v) return;
    if (e.hidden) revealed = new Map(revealed).set(e.key, v);
    editing = new Set(editing).add(e.key);
  }

  function encodingOf(e: DataEntry): DataEncoding {
    return e.binary ? "base64" : "text";
  }

  function onInput(e: DataEntry, value: string) {
    const orig = shown(e);
    edits = withValue(edits, e, value, encodingOf(e), orig ? { value: orig.value, encoding: encodingOf(e) } : null);
  }

  function valueOf(e: DataEntry): string {
    return edits.get(e.key)?.value ?? shown(e)?.value ?? "";
  }

  function remove(e: DataEntry) {
    clearMessages();
    edits = new Map(edits).set(e.key, {
      field: e.field,
      value: "",
      encoding: encodingOf(e),
      delete: true,
      added: false,
    });
  }

  function undo(key: string) {
    const next = new Map(edits);
    next.delete(key);
    edits = next;
    const ed = new Set(editing);
    ed.delete(key);
    editing = ed;
  }

  const taken = $derived(new Set([...entries.map((e) => e.key), ...edits.keys()]));
  const newKeyError = $derived(newKey ? keyError(newKey, taken) : "");
  const added = $derived(
    [...edits.entries()].filter(([, e]) => e.added).map(([key, e]) => ({ key, ...e })),
  );

  function addKey() {
    if (keyError(newKey, taken)) return;
    edits = new Map(edits).set(newKey, {
      field: "data",
      value: newValue,
      encoding: "text",
      delete: false,
      added: true,
    });
    newKey = newValue = "";
    adding = false;
  }

  /** A binary value being edited must stay valid base64. */
  const invalid = $derived(
    [...edits.entries()].filter(([, e]) => !e.delete && e.encoding === "base64" && !isBase64(e.value)).map(([k]) => k),
  );

  async function save(rv = resourceVersion) {
    clearMessages();
    if (invalid.length > 0) {
      error = `Not valid base64: ${invalid.join(", ")}.`;
      return;
    }
    busy = true;
    status = "Saving…";
    const changes = changesOf(edits);
    try {
      const res = await commands.cmdPatchData(target.resource, target.namespace, target.name, changes, rv);
      if (res.outcome === "conflict") {
        status = "";
        conflict = true;
        return;
      }
      // Changed keys are hidden again; the rest stays as it was.
      const next = new Map(revealed);
      for (const c of changes) next.delete(c.key);
      revealed = next;
      drafts.delete(id);
      edits = new Map();
      editing = new Set();
      await load();
      status = "Saved.";
    } catch (e) {
      status = "";
      error = `Could not save: ${e}`;
    } finally {
      busy = false;
    }
  }

  /** Conflict: keep the edits and write them over the latest version. Only
   *  the edited keys are sent, so other keys changed meanwhile stay. */
  async function saveOverLatest() {
    busy = true;
    await load();
    busy = false;
    if (!loadError) await save(resourceVersion);
  }

  async function reload() {
    if (dirty && !(await confirmDiscard())) return;
    clearMessages();
    await load();
  }

  onMount(() => {
    const d = drafts.get(id);
    if (d) {
      drafts.delete(id);
      edits = d.edits;
      editing = new Set([...d.edits.entries()].filter(([, e]) => !e.delete && !e.added).map(([k]) => k));
    }
    void load().then(() => {
      if (d) resourceVersion = d.resourceVersion;
    });
    let live = true;
    commands
      .cmdCheckActions(target.resource, target.namespace, ["edit"])
      .then((list) => {
        const a = list.find((x) => x.id === "edit");
        if (live && a && !a.allowed) denied = a.reason || "Not allowed to change this object.";
      })
      // A check that cannot be made counts as allowed; the save says why.
      .catch(() => {});
    return () => (live = false);
  });

  onDestroy(() => {
    // Still registered as unsaved: the guard asks before dropping these.
    if (dirty) drafts.set(id, { edits, resourceVersion });
    revealed = new Map();
  });
</script>

<section class="kv" data-testid="data-editor">
  <div class="head">
    <h3>Data{#if dirty}<span class="dirty" title="Unsaved changes"> ●</span>{/if}</h3>
    <span class="muted count">{entries.length} {entries.length === 1 ? "key" : "keys"}</span>
    <div class="head-actions">
      {#if isSecret && revealed.size > 0}
        <button type="button" class="btn" onclick={hideAll}>Hide all</button>
      {/if}
      <button type="button" class="btn" disabled={busy} onclick={reload}>Reload</button>
    </div>
  </div>
  {#if isSecret}
    <p class="muted small">Values are hidden until you reveal them, one key at a time.</p>
  {/if}
  {#if readOnlyReason}
    <p class="muted small" data-testid="data-readonly">Read-only: {readOnlyReason}</p>
  {/if}

  {#if conflict}
    <div class="banner conflict" role="alert">
      This {what} changed on the server since you loaded it.
      <div class="banner-actions">
        <button
          type="button"
          class="btn"
          disabled={busy}
          onclick={() => {
            discardEdits();
            clearMessages();
            void load();
          }}>Reload (lose my edits)</button
        >
        <button type="button" class="btn" disabled={busy} onclick={saveOverLatest}>Save my keys over it</button>
      </div>
    </div>
  {/if}
  {#if error}<div class="banner error" role="alert">{error}</div>{/if}

  {#if loadError && !loaded}
    <p class="error-text small">Could not load the data: {loadError}</p>
  {:else if !loaded}
    <p class="muted small">Loading…</p>
  {:else}
    {#if entries.length === 0 && added.length === 0}
      <p class="muted small">No keys.</p>
    {/if}
    <ul class="entries">
      {#each entries as e (e.key)}
        {@const pending = edits.get(e.key)}
        {@const v = shown(e)}
        {@const open = editing.has(e.key)}
        <li class:removed={pending?.delete} data-key={e.key}>
          <div class="row">
            <span class="key mono">{e.key}</span>
            <span class="muted meta">{sizeText(e.bytes) + (e.binary ? " · binary" : "")}</span>
            {#if pending}<span class="dirty" title="Changed">●</span>{/if}
            <span class="actions">
              {#if pending}
                <button type="button" class="btn" onclick={() => undo(e.key)}>Undo</button>
              {:else}
                {#if e.hidden}
                  {#if v}
                    <button type="button" class="btn" onclick={() => hide(e.key)}>Hide</button>
                  {:else}
                    <button type="button" class="btn" onclick={() => reveal(e)}>Reveal</button>
                  {/if}
                {/if}
                <button type="button" class="btn" onclick={() => copy(e)}>Copy</button>
                {#if !open}
                  <button
                    type="button"
                    class="btn"
                    disabled={readOnly || busy}
                    title={readOnlyReason || undefined}
                    onclick={() => startEdit(e)}>{e.binary ? "Edit as base64" : "Edit"}</button
                  >
                {/if}
                <button
                  type="button"
                  class="btn"
                  disabled={readOnly || busy}
                  title={readOnlyReason || undefined}
                  aria-label={`Remove ${e.key}`}
                  onclick={() => remove(e)}>Remove</button
                >
              {/if}
            </span>
          </div>
          {#if pending?.delete}
            <p class="muted small">Removed when you save.</p>
          {:else if open && !readOnly}
            <textarea
              class="mono value-edit"
              aria-label={`Value of ${e.key}`}
              rows={Math.min(10, Math.max(2, valueOf(e).split("\n").length))}
              value={valueOf(e)}
              oninput={(ev) => onInput(e, ev.currentTarget.value)}
            ></textarea>
            {#if e.binary}
              <p class="muted small">Binary value: edit it as base64.</p>
              {#if pending && !isBase64(pending.value)}<p class="error-text small">Not valid base64.</p>{/if}
            {/if}
          {:else if v}
            <pre class="mono value" data-testid="data-value">{v.value}</pre>
            {#if v.binary}<p class="muted small">Binary value, shown as base64.</p>{/if}
          {:else}
            <span class="mono masked" aria-label="Hidden value">••••••••</span>
          {/if}
        </li>
      {/each}
      {#each added as a (a.key)}
        <li data-key={a.key} class="new">
          <div class="row">
            <span class="key mono">{a.key}</span>
            <span class="muted meta">new</span>
            <span class="dirty" title="Added">●</span>
            <span class="actions">
              <button type="button" class="btn" onclick={() => undo(a.key)}>Undo</button>
            </span>
          </div>
          <textarea
            class="mono value-edit"
            aria-label={`Value of ${a.key}`}
            rows="2"
            value={a.value}
            oninput={(ev) =>
              (edits = new Map(edits).set(a.key, { ...edits.get(a.key)!, value: ev.currentTarget.value }))}
          ></textarea>
        </li>
      {/each}
    </ul>

    {#if adding}
      <div class="add">
        <input class="mono" placeholder="key" aria-label="New key" bind:value={newKey} />
        <textarea class="mono value-edit" placeholder="value" aria-label="New value" rows="2" bind:value={newValue}
        ></textarea>
        {#if newKeyError}<p class="error-text small">{newKeyError}</p>{/if}
        <div class="add-actions">
          <button type="button" class="btn" onclick={() => ((adding = false), (newKey = newValue = ""))}>Cancel</button>
          <button type="button" class="btn primary" disabled={!newKey || !!newKeyError} onclick={addKey}>Add</button>
        </div>
      </div>
    {:else}
      <button
        type="button"
        class="btn add-btn"
        disabled={readOnly || busy}
        title={readOnlyReason || undefined}
        onclick={() => (adding = true)}>Add key</button
      >
    {/if}

    {#if dirty}
      <div class="savebar">
        <span class="muted">{summaryOf(edits)}</span>
        <button type="button" class="btn" disabled={busy} onclick={discardEdits}>Discard</button>
        <button type="button" class="btn primary" data-testid="data-save" disabled={busy || readOnly} onclick={() => save()}
          >Save</button
        >
      </div>
    {/if}
  {/if}
  {#if status}<p class="muted small" role="status">{status}</p>{/if}
</section>

<style>
  .kv {
    margin: 14px 0 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .head h3 {
    margin: 0;
    font-size: 13px;
  }
  .count {
    font-size: 12px;
  }
  .head-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .small {
    font-size: 12px;
    margin: 0 0 6px;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .dirty {
    color: var(--amber);
    font-size: 10px;
    vertical-align: middle;
  }
  ul.entries {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  ul.entries li {
    border-top: 1px solid var(--border);
    padding: 6px 0;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .key {
    font-weight: 600;
    word-break: break-all;
  }
  .meta {
    font-size: 11px;
  }
  .actions {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .actions .btn {
    padding: 2px 8px;
    font-size: 11px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  li.removed .key {
    text-decoration: line-through;
    color: var(--text-muted);
  }
  .value {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--code-bg);
    color: var(--code-text);
    border: 1px solid var(--border);
    border-radius: 4px;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .masked {
    display: block;
    margin-top: 2px;
    color: var(--text-muted);
    letter-spacing: 2px;
  }
  .value-edit,
  .add input {
    box-sizing: border-box;
    width: 100%;
    margin-top: 4px;
    padding: 6px 8px;
    background: var(--code-bg);
    color: var(--code-text);
    border: 1px solid var(--border);
    border-radius: 4px;
    resize: vertical;
  }
  .value-edit:focus,
  .add input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add {
    border-top: 1px solid var(--border);
    padding-top: 6px;
  }
  .add-actions,
  .savebar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .savebar .muted {
    margin-right: auto;
    font-size: 12px;
  }
  .add-btn {
    margin-top: 6px;
  }
  .banner {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 12px;
    word-break: break-word;
  }
  .banner.conflict {
    border: 1px solid var(--amber);
  }
  .banner.error {
    border: 1px solid var(--red);
    color: var(--error-text);
  }
  .banner-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
</style>
