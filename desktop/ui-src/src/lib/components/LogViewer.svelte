<script lang="ts" module>
  let streamCounter = 0;
</script>

<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import VirtualList from "./VirtualList.svelte";
  import { commands, events } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import { thisWindow } from "../window";
  import type { LogContainer, WorkloadNotice } from "../bindings";
  import {
    ALL_CONTAINERS,
    LogBuffer,
    LOG_BUFFER_MAX,
    lineCountLabel,
    offerAllContainers,
    SAVED_NOTE_MS,
    savedLabel,
    tagLabel,
  } from "../logs";
  import type { TaggedText, WorkloadRef } from "../logs";
  import {
    compileQuery,
    findTime,
    indexOfId,
    lineTime,
    matchCountLabel,
    parseJumpTime,
    segments,
    stepMatch,
  } from "../logFilter";
  import type { CompiledQuery } from "../logFilter";
  import { logHeader } from "../logHeader";
  import { LogSearcher, SEARCH_CHUNK } from "../logSearch";
  import type { Hits } from "../logSearch";
  import type { PodRef } from "../stores/detail.svelte";
  import { settings } from "../stores/settings.svelte";
  import { TAIL_OPTIONS } from "../settings";

  interface Props {
    /** Single-pod mode: the pod whose logs to show. */
    pod?: PodRef;
    /** Workload mode (instead of `pod`): merged logs of all its pods. */
    workload?: WorkloadRef;
    /** Containers of the pod; the stream starts once `ready`. Unused for workloads. */
    containers?: LogContainer[];
    ready?: boolean;
    /** An inactive dock tab: lines are buffered, not rendered, until shown. */
    hidden?: boolean;
  }

  let { pod, workload, containers = [], ready = true, hidden = false }: Props = $props();
  const isWorkload = $derived(workload !== undefined);
  const title = $derived(workload ? `${workload.namespace}/${workload.name}` : pod ? `${pod.namespace}/${pod.name}` : "");

  interface Line {
    id: number;
    text: string;
    /** Set for system messages, which are not part of the buffer. */
    cls?: string;
    /** Workload mode: the pod prefix and its colour. */
    prefix?: string;
    color?: string;
    /** Search hits in `text` / `prefix` (ranges, see logFilter.ts). */
    hits?: Hits;
    prefixHits?: Hits;
    /** A line of context around a match (#339), not a match itself. */
    context?: boolean;
    /** The "--" between two groups of matches with their context. */
    sep?: boolean;
  }

  /**
   * Context lines (#339) across the chunks and updates of the display: the
   * lines since the last one shown (up to N, for "before"), how many more
   * to show after the last match, and whether a line was skipped since.
   */
  interface Ctx {
    pending: number[];
    after: number;
    gap: boolean;
    shown: boolean;
  }
  const freshCtx = (): Ctx => ({ pending: [], after: 0, gap: false, shown: false });
  const CONTEXT_OPTIONS = [0, 1, 2, 3, 5, 10];

  const LINE_HEIGHT = 18;
  const FILTER_DEBOUNCE_MS = 150;

  // Log options.
  let container = $state("");
  /** One pod, all its containers merged (tagged by container). */
  const allContainers = $derived(!isWorkload && container === ALL_CONTAINERS);
  let previous = $state(false);
  // Start from the defaults on the Settings page.
  const defaults = settings.current.logs;
  let tail = $state(TAIL_OPTIONS.includes(defaults.tail) ? defaults.tail : "200");
  let since = $state("all");
  let timestamps = $state(defaults.timestamps);
  let wrap = $state(defaults.wrap);
  let follow = $state(true);
  // Search (#220): what is typed, the toggles, and the query in use.
  let filterInput = $state("");
  let regex = $state(false);
  let matchCase = $state(false);
  /** Highlight the matches among all lines instead of hiding the others. */
  let highlightMode = $state(false);
  let query = $state.raw<CompiledQuery>({ kind: "none" });
  // Exclude (#339): lines that match it are hidden, in either mode.
  let excludeInput = $state("");
  let exclude = $state.raw<CompiledQuery>({ kind: "none" });
  let excludeError = $state("");
  /** Lines of context around each match, in filter mode (grep -C). */
  let contextLines = $state(0);
  /** The context state after the lines shown so far. */
  let ctxState = freshCtx();
  /** An invalid regex, or one that was too slow; shown next to the box. */
  let searchError = $state("");
  /** Id of the current match (n / N), or -1. */
  let currentId = $state(-1);
  let jumpInput = $state("");
  let jumpNote = $state("");
  /** Id of the line "Jump to time" went to, or -1. */
  let jumpedId = $state(-1);
  let paused = $state(false);
  // Where the last Download went: shown in the header for SAVED_NOTE_MS,
  // apart from the line count that every batch updates (#178).
  let savedPath = $state("");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  // Workload mode: which pods/containers have been seen, and the pod filter.
  let podFilter = $state("");
  let podStates = $state<Record<string, "live" | "ended">>({});
  let knownContainers = $state<string[]>([]);
  let truncatedNote = $state("");
  const containersByPod = new Map<string, Set<string>>();
  let tagInfoCache = new Map<number, { prefix: string; color: string }>();

  // The ring buffer lives outside reactive state; only the displayed lines
  // are signalled, by `rev`. Lines are numbered as they arrive (`buf.first()`
  // ..`buf.end()`); those from `shownEnd` on wait for the next frame.
  const buf = new LogBuffer();
  let shownEnd = 0;
  let flushQueued = false;
  // `matches`: ids of the shown lines that match, in order (ids only grow).
  const d = { lines: [] as Line[], matches: [] as number[] };
  let rev = $state(0);
  // The worker keeps its own copy of the buffer (#272): sent once, then
  // only the new lines.
  const searcher = new LogSearcher();
  searcher.attach(buf);
  /** Search hits of the pod prefixes, by tag id, for the query in use. */
  let prefixHits = new Map<number, Hits>();
  /** Time on the main thread before a long rebuild lets a frame through. */
  const FRAME_BUDGET_MS = 8;
  // Display updates run one at a time, in order: matching a regex is async
  // (a worker). `gen` changes on a rebuild or a clear; an update that
  // started before drops its result (the rebuild covers its lines).
  let queue: Promise<void> = Promise.resolve();
  let gen = 0;
  let lineCount = $state(0);
  let nextLineId = 0;
  let raf = 0;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;

  let list = $state<ReturnType<typeof VirtualList>>();
  let scrollEl = $state<HTMLDivElement | null>(null);

  // Events carry the id of their stream; ids only grow, so a straggler from a
  // replaced stream never matches.
  let streamId = ++streamCounter;
  /** Whether `streamId` has been started (and must be stopped). */
  let streaming = false;

  const searching = $derived(query.kind === "text" || query.kind === "regex");
  const excluding = $derived(exclude.kind === "text" || exclude.kind === "regex");
  const matchLabel = $derived.by(() => {
    void rev;
    return matchCountLabel(searching, currentId < 0 ? -1 : indexOfId(d.matches, currentId), d.matches.length);
  });
  const matchTotal = $derived.by(() => {
    void rev;
    return d.matches.length;
  });
  const count = $derived.by(() => {
    void rev;
    return d.lines.length;
  });
  const keyOf = $derived.by(() => {
    void rev;
    return (i: number) => d.lines[i]?.id ?? i;
  });
  const podNames = $derived(Object.keys(podStates).sort());
  const status = $derived((paused ? "paused · " : "") + lineCountLabel(lineCount));

  function isAtBottom(): boolean {
    return !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40;
  }

  async function followIfNeeded(wasAtBottom: boolean) {
    if (follow && wasAtBottom) {
      await tick();
      list?.scrollToBottom();
    }
  }

  function updateStatus() {
    lineCount = buf.lines.length;
  }

  /** Append a system message (error, "stream ended"); it is not in the buffer. */
  function appendLog(text: string, cls?: string) {
    // Lines that came before it go first.
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (shownEnd < buf.end()) enqueue(flushNow);
    enqueue(() => {
      const atBottom = isAtBottom();
      d.lines.push({ id: nextLineId++, text, cls });
      rev++;
      followIfNeeded(atBottom);
    });
  }

  /** Run a display update after the ones before it. */
  function enqueue(task: () => Promise<void> | void) {
    queue = queue.then(task).catch((e) => console.error("log viewer update failed", e));
  }

  /** Prefix and colour of a workload line's tag. */
  function tagInfo(tagId: number) {
    let info = tagInfoCache.get(tagId);
    if (!info) {
      const tag = buf.tags[tagId];
      const multi = (containersByPod.get(tag.pod)?.size ?? 0) > 1;
      info = tagLabel(tag, !isWorkload, multi);
      tagInfoCache.set(tagId, info);
    }
    return info;
  }

  function makeLine(text: string, tagId: number): Line {
    if (!tagId) return { id: nextLineId++, text };
    const info = tagInfo(tagId);
    return { id: nextLineId++, text, prefix: info.prefix, color: info.color };
  }

  type Built = { lines: Line[]; matches: number[] };

  /** Let a frame through when this update has used its share of one. */
  async function yieldFrame(since: { t: number }) {
    if (performance.now() - since.t < FRAME_BUDGET_MS) return;
    await new Promise((r) => setTimeout(r, 0));
    since.t = performance.now();
  }

  /** The search hits of the prefixes of `tags` not known yet (workload mode). */
  async function notePrefixHits(q: CompiledQuery, tags: number[], g: number): Promise<boolean> {
    const missing = [...new Set(tags)].filter((t) => t !== 0 && !prefixHits.has(t));
    if (missing.length === 0) return true;
    const res = await searcher.run(
      q,
      missing.map((t) => tagInfo(t).prefix),
      () => g !== gen,
    );
    if (!res || g !== gen) return false;
    missing.forEach((t, k) => prefixHits.set(t, res[k]));
    return true;
  }

  /** Append line `seq` of the buffer to `out` as context (#339). */
  function addContext(out: Built, seq: number) {
    const i = seq - buf.dropped;
    if (i < 0) return; // trimmed meanwhile
    const line = makeLine(buf.lines[i], buf.tagIds[i]);
    line.context = true;
    out.lines.push(line);
  }

  /**
   * Append line `seq` of the buffer to `out`, with its hits (none: not
   * searching), unless it is `excluded`. `ctx`: show context lines around
   * the matches (filter mode), updated as lines go by.
   */
  function addLine(out: Built, seq: number, hits: Hits | undefined, excluded: boolean, ctx: Ctx | null) {
    const i = seq - buf.dropped;
    if (i < 0) return; // trimmed meanwhile
    const tagId = buf.tagIds[i];
    if (podFilter && tagId && buf.tags[tagId].pod !== podFilter) return;
    // Hidden, and not context either: like `grep -C n x | grep -v y`.
    if (excluded) return;
    if (hits === undefined) {
      out.lines.push(makeLine(buf.lines[i], tagId));
      return;
    }
    const ph = tagId ? (prefixHits.get(tagId) ?? null) : null;
    if (hits === null && ph === null) {
      if (highlightMode) out.lines.push(makeLine(buf.lines[i], tagId));
      else if (ctx && ctx.after > 0) {
        ctx.after--;
        addContext(out, seq);
      } else if (ctx) {
        ctx.pending.push(seq);
        if (ctx.pending.length > contextLines) {
          ctx.pending.shift();
          ctx.gap = true;
        }
      }
      return;
    }
    if (ctx) {
      // A "--" between groups that are not next to each other, like grep.
      if (ctx.gap && ctx.shown) out.lines.push({ id: nextLineId++, text: "--", cls: "muted sep", sep: true });
      for (const s of ctx.pending) addContext(out, s);
      ctx.pending = [];
      ctx.gap = false;
      ctx.after = contextLines;
      ctx.shown = true;
    }
    const line = makeLine(buf.lines[i], tagId);
    line.hits = hits;
    line.prefixHits = ph;
    out.matches.push(line.id);
    out.lines.push(line);
  }

  /**
   * Display lines for the buffer's lines `from` up to `to`, built a chunk at
   * a time (#272): a regex runs on the worker's copy of the lines, and the
   * main thread lets frames through between chunks. False when a newer
   * update made this one stale, or the regex failed (it is then dropped and
   * the display rebuilt without it).
   */
  async function build(from: number, to: number, g: number, ctx: Ctx): Promise<Built | null> {
    const q = query;
    const ex = exclude;
    const out: Built = { lines: [], matches: [] };
    const since = { t: performance.now() };
    const search = q.kind === "text" || q.kind === "regex";
    const excl = ex.kind === "text" || ex.kind === "regex";
    const c = search && !highlightMode && contextLines > 0 ? ctx : null;
    let failed: "search" | "exclude" = "search";
    try {
      for (let i = from; i < to; i += SEARCH_CHUNK) {
        const end = Math.min(to, i + SEARCH_CHUNK);
        // Which lines of this chunk the exclude pattern hides.
        const hidden = new Array<boolean>(end - i).fill(false);
        if (excl) {
          failed = "exclude";
          const ok = await searcher.runRange(
            ex,
            i,
            end,
            (start, hits) => hits.forEach((x, k) => (hidden[start - i + k] = x !== null)),
            () => g !== gen,
          );
          if (!ok) return null;
          failed = "search";
        }
        if (!search) {
          for (let s = i; s < end; s++) addLine(out, s, undefined, hidden[s - i], null);
        } else {
          if (!(await notePrefixHits(q, buf.sliceTags(i, end), g))) return null;
          const ok = await searcher.runRange(
            q,
            i,
            end,
            (start, hits) => hits.forEach((h, k) => addLine(out, start + k, h, hidden[start - i + k], c)),
            () => g !== gen,
          );
          if (!ok) return null;
        }
        if (g !== gen) return null;
        await yieldFrame(since);
        if (g !== gen) return null;
      }
    } catch (e) {
      if (g === gen) {
        const msg = e instanceof Error ? e.message : String(e);
        if (failed === "exclude") {
          excludeError = `Exclude: ${msg}`;
          exclude = { kind: "none" };
        } else {
          searchError = msg;
          query = { kind: "none" };
        }
        renderLogs();
      }
      return null;
    }
    return out;
  }

  /** Keep the newest LOG_BUFFER_MAX shown lines; how many went. */
  function trimDisplay(): number {
    if (d.lines.length <= LOG_BUFFER_MAX + LOG_BUFFER_MAX / 10) return 0;
    const drop = d.lines.length - LOG_BUFFER_MAX;
    d.lines.splice(0, drop);
    const first = d.lines[0].id;
    let k = 0;
    while (k < d.matches.length && d.matches[k] < first) k++;
    if (k > 0) d.matches.splice(0, k);
    return drop;
  }

  /**
   * After an update: follow the newest line, or with Follow off (e.g. at a
   * match) keep the same lines in view when older ones were trimmed above.
   * With Follow on but scrolled up, the view is left as it was: pinning it
   * would hold it on lines that are about to be trimmed.
   */
  async function settleScroll(wasAtBottom: boolean, trimmed: number) {
    if (follow) {
      await followIfNeeded(wasAtBottom);
      return;
    }
    if (trimmed > 0 && scrollEl) {
      // A scroll to a match may still be settling on its index, which now
      // names a line `trimmed` further on (#317).
      list?.cancelScroll();
      // Read before the list shrinks: near its end the browser clamps
      // scrollTop to the new height first.
      const el = scrollEl;
      const top = el.scrollTop;
      await tick();
      el.scrollTop = Math.max(0, top - trimmed * LINE_HEIGHT);
    }
  }

  function flush() {
    raf = 0;
    if (paused || flushQueued || shownEnd >= buf.end()) return;
    flushQueued = true;
    enqueue(flushNow);
  }

  async function flushNow() {
    flushQueued = false;
    if (paused) return;
    const from = Math.max(shownEnd, buf.first());
    const to = buf.end();
    if (from >= to) return;
    shownEnd = to;
    const g = gen;
    // Committed only if this update is used.
    const ctx: Ctx = { ...ctxState, pending: [...ctxState.pending] };
    const out = await build(from, to, g, ctx);
    if (!out || g !== gen) return;
    ctxState = ctx;
    const atBottom = isAtBottom();
    for (const l of out.lines) d.lines.push(l);
    for (const m of out.matches) d.matches.push(m);
    const trimmed = trimDisplay();
    rev++;
    updateStatus();
    settleScroll(atBottom, trimmed);
  }

  /** Show new lines with the next frame; a hidden tab only renders when shown. */
  function schedule() {
    // A hidden tab keeps them in the buffer (bounded) until it is shown.
    if (hidden) return;
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function onBatch(lines: string[]) {
    buf.push(lines);
    searcher.appended(lines);
    if (paused) {
      updateStatus();
      return;
    }
    schedule();
  }

  /** Remember a pod/container of a workload stream (for the pickers and prefixes). */
  function notePod(podName: string, containerName: string, state: "live" | "ended" = "live") {
    if (podStates[podName] !== state) podStates[podName] = state;
    let set = containersByPod.get(podName);
    if (!set) containersByPod.set(podName, (set = new Set()));
    if (!set.has(containerName)) {
      set.add(containerName);
      if (set.size === 2) {
        // Prefixes now include the container.
        tagInfoCache = new Map();
        prefixHits = new Map();
      }
    }
    if (containerName && !knownContainers.includes(containerName)) {
      knownContainers = [...knownContainers, containerName].sort();
    }
  }

  function onTaggedBatch(lines: TaggedText[]) {
    for (const l of lines) {
      if (podStates[l.pod] === undefined || !containersByPod.get(l.pod)?.has(l.container)) {
        notePod(l.pod, l.container);
      }
    }
    buf.pushTagged(lines);
    searcher.appended(lines.map((l) => l.line));
    if (paused) {
      updateStatus();
      return;
    }
    schedule();
  }

  function onNotice(n: WorkloadNotice) {
    const who = `${n.pod}/${n.container}`;
    switch (n.kind) {
      case "started":
        notePod(n.pod, n.container);
        appendLog(`+ ${who} started`, "muted");
        break;
      case "ended":
      case "deleted":
        if (podStates[n.pod] !== undefined) podStates[n.pod] = "ended";
        appendLog(`- ${who} ${n.message}`, "muted");
        break;
      case "failed":
        appendLog(`! ${who}: ${n.message}`, "error-text");
        break;
      case "truncated":
        truncatedNote = n.skipped > 0 ? n.message : "";
        break;
    }
  }

  /** Rebuild the display from the buffer (filter change, resume). */
  function renderLogs() {
    const want = ++gen;
    // The query (or the prefixes it matches) may have changed.
    prefixHits = new Map();
    enqueue(() => renderNow(want));
  }

  async function renderNow(want: number) {
    if (want !== gen) return; // a newer rebuild is queued
    const from = buf.first();
    const to = buf.end();
    // Lines that come in meanwhile are shown by the next frame's update.
    shownEnd = to;
    const ctx = freshCtx();
    const out = await build(from, to, want, ctx);
    if (!out || want !== gen) return;
    ctxState = ctx;
    d.lines = out.lines;
    d.matches = out.matches;
    trimDisplay();
    currentId = -1;
    jumpedId = -1;
    rev++;
    updateStatus();
    followIfNeeded(true);
  }

  function resetLogs() {
    gen++;
    buf.clear();
    ctxState = freshCtx();
    shownEnd = buf.end();
    d.lines = [];
    d.matches = [];
    currentId = -1;
    jumpedId = -1;
    rev++;
    updateStatus();
  }

  function setPaused(value: boolean) {
    paused = value;
    if (!paused) renderLogs();
    else updateStatus();
  }

  async function startLogs() {
    resetLogs();
    setPaused(false);
    // Each tab owns its stream: stop the one it replaces (it counts towards
    // the backend's cap until then).
    const old = streaming ? streamId : null;
    streamId = ++streamCounter;
    streaming = true;
    if (old !== null) await api(visibleCluster()).cmdStopLogs(old).catch(() => {});
    podStates = {};
    containersByPod.clear();
    tagInfoCache = new Map();
    prefixHits = new Map();
    truncatedNote = "";
    try {
      if (workload) {
        await api(visibleCluster()).cmdStreamWorkloadLogs(
          workload.kind,
          workload.namespace,
          workload.name,
          {
            container: container || null,
            tailLines: tail === "all" ? null : Number(tail),
            sinceSeconds: since === "all" ? null : Number(since),
            timestamps,
          },
          streamId,
        );
        return;
      }
      if (!pod) return;
      if (container === ALL_CONTAINERS) {
        // Merged by the workload tracker; previous logs are per container.
        previous = false;
        await api(visibleCluster()).cmdStreamPodAllLogs(
          pod.namespace,
          pod.name,
          {
            container: null,
            tailLines: tail === "all" ? null : Number(tail),
            sinceSeconds: since === "all" ? null : Number(since),
            timestamps,
          },
          streamId,
        );
        return;
      }
      await api(visibleCluster()).cmdStreamPodLogs(
        pod.namespace,
        pod.name,
        container || null,
        previous,
        tail === "all" ? null : Number(tail),
        since === "all" ? null : Number(since),
        timestamps,
        streamId,
      );
    } catch (e) {
      appendLog("Could not start log stream: " + e, "error-text");
    }
  }

  async function downloadLogs() {
    const name = container === ALL_CONTAINERS ? "all" : container || (workload ? "all" : "pod");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${(workload ?? pod)?.name}_${name}${previous ? "_previous" : ""}_${stamp}.log`;
    try {
      // Written by the backend: Blob/anchor downloads are not reliable in
      // Tauri's webviews, and a save dialog would need an extra plugin.
      // With a filter, an exclude or a pod picked: the lines shown (#339);
      // else the whole buffer (also what came in while paused).
      const narrowed = (searching && !highlightMode) || excluding || podFilter !== "";
      let texts: string[];
      let out: string[];
      if (narrowed) {
        const shown = d.lines.filter((l) => !l.cls || l.sep);
        texts = shown.filter((l) => !l.sep).map((l) => l.text);
        out = shown.map((l) => (l.prefix ? l.prefix + " " + l.text : l.text));
      } else {
        texts = buf.lines;
        out = buf.lines.map((l, i) => (buf.tagIds[i] ? tagInfo(buf.tagIds[i]).prefix + " " + l : l));
      }
      const header = logHeader({
        context: visibleCluster(),
        namespace: (workload ?? pod)?.namespace ?? "",
        pod: pod?.name,
        workload: workload ? { kind: workload.kind, name: workload.name } : undefined,
        container: container === ALL_CONTAINERS ? "" : container,
        previous,
        tail,
        since,
        search: { text: searching ? filterInput : "", regex, matchCase },
        highlight: highlightMode,
        exclude: excluding ? excludeInput : "",
        contextLines,
        podFilter,
        saved: texts.length,
        buffered: buf.lines.length,
        texts,
        now: new Date(),
      });
      const path = await commands.cmdSaveLogs(filename, header + out.join("\n") + "\n");
      savedPath = path;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (savedPath = ""), SAVED_NOTE_MS);
    } catch (e) {
      appendLog("Could not save logs: " + e, "error-text");
    }
  }

  /** Use what is in the search box with the toggles; an invalid regex keeps the last good query. */
  function applySearch(force = false) {
    clearTimeout(filterTimer);
    filterTimer = undefined;
    const q = compileQuery({ text: filterInput, regex, matchCase });
    // The exclude box uses the same toggles (#339).
    const x = compileQuery({ text: excludeInput, regex, matchCase });
    // An invalid one keeps the last good one.
    const before = JSON.stringify([query, exclude]);
    if (x.kind === "error") excludeError = `Invalid exclude regex: ${x.message}`;
    else {
      excludeError = "";
      exclude = x;
    }
    if (q.kind === "error") searchError = `Invalid regex: ${q.message}`;
    else {
      searchError = "";
      query = q;
    }
    if (force || JSON.stringify([query, exclude]) !== before) renderLogs();
  }

  // Typing is debounced: each search rebuilds the display from the buffer.
  function onFilterInput() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => applySearch(), FILTER_DEBOUNCE_MS);
  }

  function toggle(which: "case" | "regex" | "mode") {
    if (which === "case") matchCase = !matchCase;
    else if (which === "regex") regex = !regex;
    else highlightMode = !highlightMode;
    applySearch(which === "mode");
  }

  /** The context select changed (bound value first). */
  async function onContextChange() {
    await tick();
    applySearch(true);
  }

  /** Index of the shown line with id `id`, or -1 (ids grow down the list). */
  function lineIndex(id: number): number {
    const lines = d.lines;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].id === id) return mid;
      if (lines[mid].id < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Where n / N start without a current match: just before the first line
   * in view going forward (so it counts), the last one in view going back.
   */
  function viewEdgeId(forward: boolean): number {
    if (!scrollEl) return -1;
    const top = scrollEl.getBoundingClientRect();
    let first = Infinity;
    let last = -1;
    for (const row of scrollEl.querySelectorAll<HTMLElement>(".vrow")) {
      const r = row.getBoundingClientRect();
      if (r.bottom <= top.top || r.top >= top.bottom) continue;
      const i = Number(row.dataset.index);
      first = Math.min(first, i);
      last = Math.max(last, i);
    }
    if (last < 0) return -1;
    return forward ? (d.lines[first]?.id ?? 0) - 1 : (d.lines[last]?.id ?? -1);
  }

  /** Go to the next / previous match (after the display has caught up). */
  function goMatch(forward: boolean) {
    // Enter right after typing: run the search first.
    if (filterTimer !== undefined) applySearch();
    enqueue(async () => {
      // Without a current match (or once it is trimmed off a busy stream):
      // from the lines in view.
      const cur = currentId >= 0 && indexOfId(d.matches, currentId) >= 0 ? currentId : -1;
      const pos = stepMatch(d.matches, cur, forward, cur < 0 ? viewEdgeId(forward) : -1);
      if (pos < 0) return;
      currentId = d.matches[pos];
      // Following would scroll the match out of view with the next lines (#272).
      follow = false;
      const index = lineIndex(currentId);
      await tick();
      list?.scrollToIndex(index, "center");
    });
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      goMatch(!e.shiftKey);
    }
  }

  /** n / N in the log output, like less and vim. */
  function onOutputKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || !searching) return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      goMatch(e.key === "n");
    }
  }

  const textOf = (i: number) => (d.lines[i]?.cls ? undefined : d.lines[i]?.text);

  /** Scroll to the first shown line at or after the time in the box. */
  async function jumpToTime() {
    jumpNote = "";
    let latest = NaN;
    for (let i = d.lines.length - 1; i >= 0 && Number.isNaN(latest); i--) {
      const t = textOf(i);
      if (t !== undefined) latest = lineTime(t);
    }
    const target = parseJumpTime(jumpInput, latest);
    if (Number.isNaN(target)) {
      jumpNote = "Not a time: type HH:MM[:SS] or 2026-11-16 10:30";
      return;
    }
    const r = findTime(d.lines.length, textOf, target);
    if (r.kind === "no-times") {
      jumpNote = timestamps ? "No line here has a time" : "The lines have no time: turn on Timestamps";
      return;
    }
    if (r.kind === "after-last") jumpNote = "Nothing that late: at the newest line";
    else if (r.first) {
      const first = lineTime(d.lines[r.index].text);
      if (first > target + 1000) jumpNote = `Nothing that early: the oldest line is from ${new Date(first).toLocaleString()}`;
    }
    jumpedId = d.lines[r.index].id;
    await tick();
    list?.scrollToIndex(r.index, "start");
  }

  // Start streaming once the pod's containers are known (or failed to load).
  let started = false;
  $effect(() => {
    if (!ready || started) return;
    started = true;
    // Workloads follow all containers by default.
    const firstMain = isWorkload ? undefined : containers.find((c) => !c.init);
    container = firstMain?.name ?? "";
    startLogs();
  });

  // The stream restarts when an option changes (but not for wrap/filter/follow).
  async function restart() {
    // `bind:` and `onchange` both run on change; wait for the bound value.
    await tick();
    if (started) startLogs();
  }

  async function renderSoon() {
    await tick();
    renderLogs();
  }

  /** Following again: back to the newest line. */
  async function toggleFollow() {
    await tick();
    if (follow) list?.scrollToBottom();
  }

  async function toggleWrap() {
    await tick();
    followIfNeeded(true);
  }

  let unlisteners: (() => void)[] = [];
  let destroyed = false;
  onMount(async () => {
    const un = await Promise.all([
      events.podLog(thisWindow()).listen((e) => e.payload.streamId === streamId && onBatch(e.payload.data)),
      events.workloadLog(thisWindow()).listen((e) => e.payload.streamId === streamId && onTaggedBatch(e.payload.data)),
      events.workloadNotice(thisWindow()).listen((e) => e.payload.streamId === streamId && onNotice(e.payload)),
      events.podLogDone(thisWindow()).listen((e) => e.payload.streamId === streamId && appendLog("[stream ended]", "muted")),
      events.podLogError(thisWindow()).listen((e) => e.payload.streamId === streamId && appendLog(e.payload.data, "error-text")),
    ]);
    if (destroyed) un.forEach((f) => f());
    else unlisteners = un;
  });

  onDestroy(() => {
    destroyed = true;
    unlisteners.forEach((f) => f());
    cancelAnimationFrame(raf);
    clearTimeout(filterTimer);
    gen++;
    searcher.stop();
    clearTimeout(savedTimer);
    const ownStream = streamId;
    streamId = ++streamCounter;
    // Stops this tab's stream only; the other tabs keep theirs.
    if (streaming) api(visibleCluster()).cmdStopLogs(ownStream).catch(() => {});
  });

  // A tab that is shown again renders what arrived while it was hidden.
  $effect(() => {
    if (!hidden && shownEnd < buf.end() && !raf) raf = requestAnimationFrame(flush);
  });
</script>

<div class="logs-header section-header">
  <h3>Logs<span class="muted"> · {title}</span></h3>
  <label class="check" title="Keep the newest line in view; going to a match turns it off"
    ><input type="checkbox" bind:checked={follow} onchange={toggleFollow} /> Follow</label
  >
  <button type="button" class="btn" class:active={paused} onclick={() => setPaused(!paused)}>
    {paused ? "Resume" : "Pause"}
  </button>
  <button type="button" class="btn" onclick={resetLogs}>Clear</button>
  <span class="saved" role="status" data-testid="log-saved" title={savedPath || undefined}
    >{#if savedPath}Saved to {savedLabel(savedPath)}{/if}</span
  >
  <button type="button" class="btn" onclick={downloadLogs}>Download</button>
</div>
<div class="logs-options">
  {#if isWorkload}
    <select class="mini" title="Pod" bind:value={podFilter} onchange={renderSoon}>
      <option value="">All pods ({podNames.length})</option>
      {#each podNames as p (p)}
        <option value={p}>{p}{podStates[p] === "ended" ? " (ended)" : ""}</option>
      {/each}
    </select>
    <select class="mini" title="Container" bind:value={container} onchange={restart}>
      <option value="">All containers</option>
      {#each knownContainers as c (c)}
        <option value={c}>{c}</option>
      {/each}
    </select>
  {:else}
    <select class="mini" title="Container" bind:value={container} onchange={restart}>
      {#if offerAllContainers(containers)}
        <option value={ALL_CONTAINERS}>All containers</option>
      {/if}
      {#each containers as c (c.name)}
        <option value={c.name}>{c.init ? `${c.name} (init)` : c.name}</option>
      {/each}
    </select>
    <label class="check" title={allContainers ? "Pick one container to see its previous logs" : undefined}>
      <input type="checkbox" bind:checked={previous} disabled={allContainers} onchange={restart} /> Previous
    </label>
  {/if}
  <select class="mini" title="Tail lines" bind:value={tail} onchange={restart}>
    <option value="100">100 lines</option>
    <option value="200">200 lines</option>
    <option value="1000">1000 lines</option>
    <option value="5000">5000 lines</option>
    <option value="all">All lines</option>
  </select>
  <select class="mini" title="Since" bind:value={since} onchange={restart}>
    <option value="all">All time</option>
    <option value="300">Last 5m</option>
    <option value="3600">Last 1h</option>
  </select>
  <label class="check"><input type="checkbox" bind:checked={timestamps} onchange={restart} /> Timestamps</label>
  <label class="check"><input type="checkbox" bind:checked={wrap} onchange={toggleWrap} /> Wrap</label>
  <span class="muted">{status}</span>
  {#if truncatedNote}<span class="warn" title="At most 20 containers are followed at once">{truncatedNote}</span>{/if}
</div>
<div class="logs-search" data-testid="log-search">
  <input
    class="mini filter"
    class:invalid={searchError !== ""}
    type="search"
    placeholder={highlightMode ? "Find in logs…" : "Filter logs…"}
    aria-label={highlightMode ? "Find in logs" : "Filter logs"}
    aria-invalid={searchError !== "" ? "true" : undefined}
    title="Enter: next match, Shift+Enter: previous"
    spellcheck="false"
    autocomplete="off"
    bind:value={filterInput}
    oninput={onFilterInput}
    onkeydown={onSearchKey}
  />
  <input
    class="mini exclude"
    class:invalid={excludeError !== ""}
    type="search"
    placeholder="Exclude…"
    aria-label="Exclude lines"
    aria-invalid={excludeError !== "" ? "true" : undefined}
    title="Hide the lines that match (like grep -v); uses the Aa and .* toggles"
    spellcheck="false"
    autocomplete="off"
    bind:value={excludeInput}
    oninput={onFilterInput}
  />
  <button
    type="button"
    class="btn icon"
    class:active={matchCase}
    aria-pressed={matchCase}
    title="Match case"
    onclick={() => toggle("case")}>Aa</button
  >
  <button
    type="button"
    class="btn icon mono"
    class:active={regex}
    aria-pressed={regex}
    title="Regular expression"
    onclick={() => toggle("regex")}>.*</button
  >
  <button
    type="button"
    class="btn icon"
    class:active={highlightMode}
    aria-pressed={highlightMode}
    title="Highlight the matches and keep the other lines, instead of filtering"
    onclick={() => toggle("mode")}>Highlight</button
  >
  <select
    class="mini context"
    aria-label="Context lines"
    title={highlightMode
      ? "Context lines are for filtering: Highlight keeps every line"
      : "Lines of context before and after each match (like grep -C)"}
    disabled={highlightMode}
    bind:value={contextLines}
    onchange={onContextChange}
  >
    {#each CONTEXT_OPTIONS as n (n)}
      <option value={n}>{n === 0 ? "No context" : `Context ±${n}`}</option>
    {/each}
  </select>
  <span class="count" role="status" data-testid="log-match-count">{matchLabel}</span>
  <button
    type="button"
    class="btn icon"
    title="Previous match (Shift+Enter, or N in the log)"
    aria-label="Previous match"
    disabled={matchTotal === 0}
    onclick={() => goMatch(false)}>↑</button
  >
  <button
    type="button"
    class="btn icon"
    title="Next match (Enter, or n in the log)"
    aria-label="Next match"
    disabled={matchTotal === 0}
    onclick={() => goMatch(true)}>↓</button
  >
  {#if searchError}<span class="search-error" role="alert" data-testid="log-search-error" title={searchError}
      >{searchError}</span
    >{/if}
  {#if excludeError}<span class="search-error" role="alert" data-testid="log-exclude-error" title={excludeError}
      >{excludeError}</span
    >{/if}
  {#if jumpNote}<span class="jump-note" role="status" data-testid="log-jump-note" title={jumpNote}>{jumpNote}</span>{/if}
  <form
    class="jump"
    onsubmit={(e) => {
      e.preventDefault();
      jumpToTime();
    }}
  >
    <input
      class="mini jump-input"
      type="text"
      placeholder="Jump to time"
      aria-label="Jump to time"
      title="HH:MM[:SS] (local time) or 2026-11-16 10:30; needs lines with a time (Timestamps)"
      spellcheck="false"
      autocomplete="off"
      bind:value={jumpInput}
    />
    <button type="submit" class="btn icon" disabled={jumpInput.trim() === ""}>Go</button>
  </form>
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="output"
  data-testid="log-output"
  style:--line-height="{LINE_HEIGHT}px"
  tabindex="0"
  role="log"
  aria-label="Log lines (n / N: next / previous match)"
  onkeydown={onOutputKey}
>
  {#key wrap}
    <VirtualList
      bind:this={list}
      bind:scrollEl
      {count}
      rowHeight={LINE_HEIGHT}
      dynamic={wrap}
      scrollX={!wrap}
      overscan={20}
      getKey={keyOf}
    >
      {#snippet row(i)}
        {@const line = d.lines[i]}
        {#if line}
          <div
            class="line {line.cls ?? ''}"
            class:wrap
            class:current={line.id === currentId}
            class:jumped={line.id === jumpedId}
            class:context={line.context}
            data-testid="log-line"
          >
            {#if line.prefix}<span class="pod" style:color={line.color}
                >{#each segments(line.prefix, line.prefixHits) as seg}{#if seg.hit}<mark>{seg.text}</mark
                    >{:else}{seg.text}{/if}{/each}</span
              >{/if}{#each segments(line.text, line.hits) as seg}{#if seg.hit}<mark>{seg.text}</mark
                >{:else}{seg.text}{/if}{/each}
          </div>
        {/if}
      {/snippet}
    </VirtualList>
  {/key}
</div>

<style>
  .logs-header h3 {
    margin: 0;
    font-size: 13px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .logs-header > :not(h3, .saved) {
    flex-shrink: 0;
  }
  /* One line at most: it never wraps the header or moves the log list. */
  .saved {
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--green, var(--text-muted));
    font-size: 12px;
  }
  .logs-options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 6px 16px;
    font-size: 12px;
  }
  .check {
    color: var(--text-muted);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mini {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 6px;
    font-size: 12px;
  }
  .mini option {
    background: var(--bg-raised);
  }
  .logs-search {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 16px 6px;
    font-size: 12px;
    min-width: 0;
  }
  /* A set width: an error next to it shrinks (with an ellipsis), not the box. */
  .filter {
    flex: 0 0 auto;
    width: clamp(140px, 26vw, 400px);
  }
  .exclude {
    flex: 0 0 auto;
    width: clamp(90px, 13vw, 220px);
  }
  .context {
    flex-shrink: 0;
  }
  .context:disabled {
    opacity: 0.45;
  }
  /* Context around a match (#339): dimmer than the matches themselves. */
  .line.context {
    color: #8b929b;
  }
  .mini:focus {
    outline: none;
    border-color: var(--accent);
  }
  .mini.invalid {
    border-color: var(--red);
  }
  .icon {
    padding: 2px 7px;
    line-height: 1.2;
    flex-shrink: 0;
  }
  .icon.mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .icon:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .count {
    min-width: 72px;
    padding: 0 4px;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: center;
    flex-shrink: 0;
  }
  .search-error,
  .jump-note {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-error {
    color: var(--red);
  }
  /* Next to the box it is about, at the right end. */
  .jump-note {
    margin-left: auto;
    padding-left: 8px;
  }
  .jump-note + .jump {
    margin-left: 0;
  }
  .jump-note {
    color: var(--amber);
  }
  .jump {
    display: flex;
    align-items: center;
    gap: 4px;
    /* At the right end: an error or note before it does not move it. */
    margin-left: auto;
    padding-left: 8px;
    flex-shrink: 0;
  }
  .jump-input {
    width: 130px;
  }
  .output:focus {
    outline: none;
  }
  .output:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .output {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 40px;
    background: #0d1013;
    color: #d6dae0;
    border-top: 1px solid var(--border);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    padding: 0 0 0 16px;
  }
  .line {
    min-height: var(--line-height);
    line-height: var(--line-height);
    white-space: pre;
    width: max-content;
    min-width: 100%;
  }
  .line.wrap {
    white-space: pre-wrap;
    word-break: break-all;
    width: auto;
  }
  .line :global(mark),
  mark {
    background: #8a6d00;
    color: inherit;
    border-radius: 2px;
  }
  /* The current match (n / N) and the line "Jump to time" went to. */
  .line.current {
    background: rgba(209, 134, 22, 0.18);
  }
  .line.current mark {
    background: #d18616;
    color: #0d1013;
  }
  .line.jumped {
    box-shadow: inset 3px 0 0 var(--accent);
    background: rgba(79, 156, 247, 0.12);
  }
  .muted {
    color: var(--text-muted);
  }
  .line.muted {
    color: var(--text-muted);
  }
  .pod {
    margin-right: 8px;
    font-weight: 600;
  }
  .warn {
    color: var(--amber);
  }
  .line.error-text {
    color: #f5a3a5;
  }
</style>
