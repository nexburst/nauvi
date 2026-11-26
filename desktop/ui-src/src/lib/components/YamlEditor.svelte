<script lang="ts" module>
  /** Edits kept while the editor is unmounted (another tab of the panel,
   *  or the same object re-opened), until saved or discarded. */
  interface Draft {
    base: string;
    text: string;
    resourceVersion: string;
    revealed: boolean;
  }
  const drafts = new Map<string, Draft>();
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import CodeEditor from "./editor/CodeEditor.svelte";
  import DiffView from "./editor/DiffView.svelte";
  import YamlStatusBar from "./editor/YamlStatusBar.svelte";
  import { api, visibleCluster } from "../cluster";
  import { rawText } from "../rawIpc";
  import type { ApplyOutcome, FieldTakeover } from "../bindings";
  import { currentContextName } from "../stores/app.svelte";
  import { notify } from "../stores/notifications.svelte";
  import { hhmmss } from "../timeZone";
  import type { Target } from "../stores/detail.svelte";
  import { confirmDiscard, markSaved, markUnsaved } from "../stores/unsaved.svelte";
  import { errorLine, resourceVersionOf } from "../yamlEdit";
  import type { DiffLayout } from "../editor/setup";

  let { target }: { target: Target } = $props();

  // The panel is remounted for every object, so `target` is fixed here.
  // svelte-ignore state_referenced_locally
  const isSecret = target.resource.group === "" && target.resource.kind === "Secret";
  // svelte-ignore state_referenced_locally
  const id = `yaml|${target.resource.group}/${target.resource.kind}|${target.namespace}/${target.name}`;

  /** What the server holds (as last loaded): the left side of the diff. */
  let base = $state("");
  /** The editor's text. */
  let text = $state("");
  /** `metadata.resourceVersion` of `base`: a save checks it is still current. */
  let resourceVersion = $state("");
  let status = $state("");
  /** Validation or save error from the API server, and the line it names. */
  let error = $state("");
  let errorAt = $state<number | null>(null);
  /** Secret values are hidden until the user asks for them. */
  let revealed = $state(false);
  /** Nothing to save until a load succeeded. */
  let loaded = $state(false);
  let busy = $state(false);
  /** Reviewing the diff before saving. */
  let reviewing = $state(false);
  let layout = $state<DiffLayout>("unified");
  /** Set when a save stopped because the object changed on the server:
   *  the fields both sides changed (empty if not known). */
  let conflict = $state.raw<{ fields: string[]; reason: string } | null>(null);
  /** The fields the server changed that the edit was re-applied on top
   *  of, while reviewing that (#495). */
  let rebased = $state.raw<string[]>([]);
  /** Reviewing the edit against a latest version that changed the same
   *  fields: saving replaces those changes. */
  let overwrite = $state(false);
  /** When the last save went through, until the next edit. */
  let savedAt = $state("");
  /** Fields the save would take over (review), or took over (after it). */
  let pendingTakeovers = $state.raw<FieldTakeover[]>([]);
  let takeovers = $state.raw<FieldTakeover[]>([]);

  const locked = $derived(isSecret && !revealed);
  const dirty = $derived(loaded && text !== base);

  $effect(() => {
    if (dirty) markUnsaved(id, discardEdits);
    else markSaved(id);
  });
  // A new edit: the last save's notice is old news.
  $effect(() => {
    if (dirty) untrack(() => (savedAt = ""));
  });

  /** The user discarded the edits (here, or from the guard dialog). */
  function discardEdits() {
    drafts.delete(id);
    text = base;
    reviewing = false;
    rebased = [];
  }

  function clearMessages() {
    status = "";
    error = "";
    errorAt = null;
    conflict = null;
    takeovers = [];
    pendingTakeovers = [];
  }

  async function fetchYaml(): Promise<string> {
    return rawText(await api(visibleCluster()).cmdGetResourceYaml(target.resource, target.namespace, target.name, revealed));
  }

  async function load() {
    clearMessages();
    savedAt = "";
    rebased = [];
    overwrite = false;
    reviewing = false;
    loaded = false;
    status = "Loading…";
    try {
      const yaml = await fetchYaml();
      base = yaml;
      text = yaml;
      resourceVersion = resourceVersionOf(yaml);
      loaded = true;
      status = "";
    } catch (e) {
      base = text = "";
      status = "Could not load YAML: " + e;
    }
  }

  /** Reload, Reveal and Hide drop the edits: ask first. */
  async function reloadAsking(reveal: boolean) {
    if (dirty && !(await confirmDiscard())) return;
    revealed = reveal;
    await load();
  }

  function showError(prefix: string, e: unknown) {
    error = prefix + e;
    errorAt = errorLine(String(e), text);
    reviewing = false;
  }

  /** How often a review takes the server's newer version in a row. */
  const REBASES = 3;

  /**
   * Apply (or test) the edit. The backend sends the YAML as it was loaded
   * too: a newer version on the server that changed only its own fields
   * (a rollout's status) is no conflict, and one that changed other fields
   * comes back with the edit re-applied on it ("rebased", #495).
   */
  async function apply(dryRun: boolean): Promise<ApplyOutcome> {
    for (let i = 0; ; i++) {
      const res = await api(visibleCluster()).cmdApplyResourceYaml(
        target.resource,
        target.namespace,
        target.name,
        text,
        resourceVersion,
        base,
        dryRun,
      );
      if (res.outcome !== "rebased" || i >= REBASES) return res;
      // Review the edit on the latest version: the new base of the diff.
      base = res.latest;
      text = res.yaml;
      resourceVersion = res.resource_version;
      rebased = res.changed;
      // Nothing was saved: a save goes back to the review.
      if (!dryRun) return res;
    }
  }

  /**
   * Validate with a server dry run, then show the diff. A new review starts
   * without the notes of the last one, unless the caller just set them
   * (`keepNotes`: the edit re-applied by a save, or Compare with the latest).
   */
  async function review(keepNotes = false) {
    if (!keepNotes) {
      rebased = [];
      overwrite = false;
    }
    clearMessages();
    savedAt = "";
    busy = true;
    status = "Checking with the server…";
    try {
      const res = await apply(true);
      status = "";
      if (res.outcome === "conflict") {
        conflict = { fields: res.fields, reason: res.reason };
        return;
      }
      if (res.outcome === "rebased") {
        conflict = { fields: [], reason: "" };
        return;
      }
      pendingTakeovers = res.takeovers;
      reviewing = true;
    } catch (e) {
      status = "";
      showError("The server rejected this YAML: ", e);
    } finally {
      busy = false;
    }
  }

  async function save() {
    busy = true;
    status = "Saving…";
    try {
      const res = await apply(false);
      if (res.outcome === "conflict") {
        status = "";
        reviewing = false;
        conflict = { fields: res.fields, reason: res.reason };
        return;
      }
      if (res.outcome === "rebased") {
        // Changed again since the review: review the new version (`apply`
        // set its note; an overwrite was of the version before).
        overwrite = false;
        busy = false;
        await review(true);
        return;
      }
      // Reload so the editor shows what the server now holds.
      await load();
      drafts.delete(id);
      takeovers = res.takeovers;
      savedAt = hhmmss(Date.now());
      notify("success", `Saved the YAML of ${target.resource.kind} ${target.name}.`, currentContextName(), {
        resource: target.resource,
        namespace: target.namespace,
        name: target.name,
      });
    } catch (e) {
      status = "";
      showError("Could not save YAML: ", e);
    } finally {
      busy = false;
    }
  }

  /** Leave the review: its notes were about that review. */
  function backToEditing() {
    reviewing = false;
    rebased = [];
    overwrite = false;
  }

  /** Conflict: keep the edits, compare them with the server's latest. */
  async function diffLatest() {
    busy = true;
    try {
      const latest = await fetchYaml();
      base = latest;
      resourceVersion = resourceVersionOf(latest);
      rebased = [];
      overwrite = true;
    } catch (e) {
      busy = false;
      status = "Could not load YAML: " + e;
      return;
    }
    busy = false;
    await review(true);
  }

  onMount(() => {
    const d = drafts.get(id);
    if (!d) return void load();
    drafts.delete(id);
    ({ base, text, resourceVersion, revealed } = d);
    loaded = true;
  });

  onDestroy(() => {
    // Still registered as unsaved: the guard asks before dropping these.
    if (dirty) drafts.set(id, { base, text, resourceVersion, revealed });
  });
</script>

<div class="section-header slim">
  <h3>YAML{#if dirty}<span class="dirty" title="Unsaved changes"> ●</span>{/if}</h3>
  {#if reviewing}
    <div class="layout" role="group" aria-label="Diff layout">
      <button type="button" class="btn" aria-pressed={layout === "unified"} onclick={() => (layout = "unified")}
        >Unified</button
      >
      <button type="button" class="btn" aria-pressed={layout === "split"} onclick={() => (layout = "split")}
        >Side by side</button
      >
    </div>
    <button type="button" class="btn" disabled={busy} onclick={backToEditing}>Back to editing</button>
    <button type="button" class="btn primary" data-testid="yaml-save" disabled={busy} onclick={save}>Save</button>
  {:else}
    {#if isSecret}
      {#if revealed}
        <button type="button" class="btn" disabled={busy} onclick={() => reloadAsking(false)}>Hide values</button>
      {:else}
        <button type="button" class="btn" disabled={busy} onclick={() => reloadAsking(true)}>Reveal values</button>
      {/if}
    {/if}
    <button type="button" class="btn" disabled={busy} onclick={() => reloadAsking(revealed)}>Reload</button>
    <button type="button" class="btn primary" data-testid="yaml-review" onclick={() => review()} disabled={locked || !dirty || busy}
      >Review & save…</button
    >
  {/if}
</div>

<YamlStatusBar
  progress={status}
  hint={locked ? "Values are hidden. Reveal them to edit this Secret." : ""}
  {savedAt}
  {reviewing}
  {rebased}
  {overwrite}
  {pendingTakeovers}
  {takeovers}
  {conflict}
  {error}
  {errorAt}
>
  {#snippet conflictActions()}
    <button type="button" class="btn" disabled={busy} onclick={load}>Reload (lose my edits)</button>
    <button type="button" class="btn" disabled={busy} onclick={diffLatest}>Compare with the latest</button>
  {/snippet}
</YamlStatusBar>

<div class="pane">
  {#if reviewing}
    {#if base === text}
      <p class="muted nochange">No changes.</p>
    {:else}
      <DiffView original={base} modified={text} {layout} label="{target.resource.kind} YAML changes" />
    {/if}
  {:else}
    <CodeEditor
      value={text}
      readonly={locked || !loaded}
      label="{target.resource.kind} YAML"
      testid="yaml-editor"
      markLine={errorAt}
      onChange={(v) => {
        text = v;
        if (errorAt !== null) errorAt = null;
      }}
    />
  {/if}
</div>

<style>
  /* The tab already says YAML: this row is for the unsaved mark and the
     actions, and it is slim. */
  .slim {
    padding-top: 4px;
    padding-bottom: 4px;
    border-top: none;
  }
  .slim h3 {
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .pane {
    height: 50vh;
    min-height: 220px;
    border-top: 1px solid var(--border);
    resize: vertical;
    overflow: hidden;
  }
  .dirty {
    color: var(--amber);
    font-size: 10px;
    vertical-align: middle;
  }
  .layout {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  .layout .btn[aria-pressed="true"] {
    border-color: var(--accent);
    color: var(--text);
  }
  .nochange {
    padding: 10px 16px;
    margin: 0;
    font-size: 12px;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
