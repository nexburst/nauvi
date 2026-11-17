<script module lang="ts">
  import { commands } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import type { PodRef } from "../stores/detail.svelte";
  import { orderedInput } from "../orderedInput";
  import { kubectlIntro } from "../kubectlMatch";

  /** A shell in a pod, one on this machine pointed at `namespace`, an
   *  ephemeral debug container, or a root shell on a node. */
  export type TerminalTarget =
    /** `container`: `null` lets the API server pick. */
    | { kind: "pod"; pod: PodRef; container: string | null }
    /** The container's main process (`null`: the pod's default container). */
    | { kind: "attach"; pod: PodRef; container: string | null }
    | { kind: "local"; namespace: string }
    /** Adds a container running `image` that shares `target`'s processes, then attaches. */
    | { kind: "debug"; pod: PodRef; target: string; image: string }
    /** A privileged pod on `node` in `namespace`, deleted when the session ends. */
    | { kind: "nodeShell"; node: string; namespace: string };

  /** The session commands of a target. Both kinds stream through the
   *  `exec-output` and `exec-closed` events. */
  interface Backend {
    /** The session id, and a note to show before the shell's output. */
    start(cols: number, rows: number): Promise<{ id: string; intro: string; kubectl?: string }>;
    input(id: string, data: string): Promise<unknown>;
    resize(id: string, cols: number, rows: number): Promise<unknown>;
    close(id: string): Promise<unknown>;
    /** The session id `start` runs under when the UI picks it: its output
     *  (progress while a container or pod starts) shows before `start` resolves. */
    pending?: string;
  }

  function randomId(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function backendFor(t: TerminalTarget): Backend {
    if (t.kind === "debug" || t.kind === "nodeShell") {
      const pending = `ui-${randomId()}`;
      return {
        pending,
        start: async (cols, rows) => ({
          id:
            t.kind === "debug"
              ? await api(visibleCluster()).cmdDebugStart(pending, t.pod.namespace, t.pod.name, t.target, t.image, cols, rows)
              : await api(visibleCluster()).cmdNodeShellStart(pending, t.node, t.namespace, cols, rows),
          intro: "",
        }),
        input: api(visibleCluster()).cmdExecInput,
        resize: api(visibleCluster()).cmdExecResize,
        close: api(visibleCluster()).cmdExecClose,
      };
    }
    if (t.kind === "pod" || t.kind === "attach") {
      const start = t.kind === "pod" ? api(visibleCluster()).cmdExecStart : api(visibleCluster()).cmdAttachStart;
      return {
        start: async (cols, rows) => ({
          id: await start(t.pod.namespace, t.pod.name, t.container, cols, rows),
          intro: "",
        }),
        input: api(visibleCluster()).cmdExecInput,
        resize: api(visibleCluster()).cmdExecResize,
        close: api(visibleCluster()).cmdExecClose,
      };
    }
    return {
      start: async (cols, rows) => {
        const s = await api(visibleCluster()).cmdLocalShellStart(t.namespace, cols, rows);
        return {
          id: s.session,
          intro:
            `\x1b[90mLocal shell: kubectl uses context ${s.context}, namespace ${s.namespace}.\r\n` +
            "Changing the app's namespace or context does not change this shell.\x1b[0m\r\n" +
            kubectlIntro(s.kubectl),
          kubectl: s.kubectl,
        };
      },
      input: api(visibleCluster()).cmdLocalShellInput,
      resize: api(visibleCluster()).cmdLocalShellResize,
      close: api(visibleCluster()).cmdLocalShellClose,
    };
  }
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { SearchAddon } from "@xterm/addon-search";
  import "@xterm/xterm/css/xterm.css";
  import TerminalSearch from "./TerminalSearch.svelte";
  import { HIGHLIGHT_LIMIT } from "../terminalSearch";
  import { registerTerminalSearch } from "../stores/keyboard.svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { webLink } from "../terminalLinks";
  import { events } from "../bindings";
  import { thisWindow } from "../window";
  import { settings } from "../stores/settings.svelte";
  import KubectlOffer from "./KubectlOffer.svelte";

  interface Props {
    target: TerminalTarget;
    /** The shown dock tab: it gets the focus. Hidden tabs keep their session. */
    active?: boolean;
  }

  let { target, active = true }: Props = $props();

  // Picked once: a tab's target never changes.
  let backend: Backend | null = null;

  let host: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  /** Ctrl+Shift+F / ⌘F (#222). */
  let search = $state.raw<SearchAddon | null>(null);
  let searchBar = $state<ReturnType<typeof TerminalSearch> | null>(null);
  let box: HTMLDivElement;
  let session: string | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let unlisteners: (() => void)[] = [];
  let destroyed = false;
  /** Output that arrived before the start command told us our session id,
   *  by session: other terminals are open too, so it is not all ours. */
  let early = new Map<string, string[]>();
  let closedEarly = new Set<string>();
  let lastSize = "";
  /** A local shell, once started: the downloaded kubectl it uses (#331). */
  let localKubectl = $state<string | null>(null);

  function sendResize() {
    // A hidden tab has no size; refit when it is shown again.
    if (!term || !fit || !session || host.clientHeight === 0) return;
    fit.fit();
    const size = `${term.cols}x${term.rows}`;
    if (size === lastSize) return;
    lastSize = size;
    backend?.resize(session, term.cols, term.rows).catch(() => {});
  }

  const closedNote = "\r\n\x1b[90m[session closed]\x1b[0m\r\n";

  $effect(() => {
    if (active && session) term?.focus();
  });

  // The shortcut opens the search of the terminal it was pressed in.
  const unregisterSearch = registerTerminalSearch((target) => {
    if (!active || !searchBar || !target || !box?.contains(target)) return false;
    searchBar.open(term?.getSelection() ?? "");
    return true;
  });

  // The font size from Settings (#207), changed live: refit to the new cell size.
  const fontSize = $derived(settings.current.terminal_font_size);
  $effect(() => {
    const size = fontSize;
    if (!term || term.options.fontSize === size) return;
    term.options.fontSize = size;
    sendResize();
  });

  onMount(async () => {
    const b = backendFor(target);
    backend = b;
    const t = new Terminal({
      cursorBlink: true,
      fontSize,
      theme: { background: "#0d1013" },
      // The search addon highlights matches with decorations (#222).
      allowProposedApi: true,
      // OSC 8 links from the output (#245): only http(s), in the browser.
      // xterm already drops other schemes (`allowNonHttpProtocols` is off);
      // `webLink` checks again. The tooltip shows where a link goes, since
      // its text can say anything.
      linkHandler: {
        activate: (_event, uri) => {
          const url = webLink(uri);
          if (url) openUrl(url).catch(() => {});
        },
        hover: (_event, uri) => {
          host.title = webLink(uri) ?? "";
        },
        leave: () => {
          host.title = "";
        },
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    const s = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
    t.loadAddon(s);
    t.open(host);
    f.fit();
    term = t;
    fit = f;
    search = s;

    resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(host);

    // Output can arrive before the start command resolves and `session` is set:
    // keep it by session until we know which one is ours.
    const un = await Promise.all([
      events.execOutput(thisWindow()).listen((e) => {
        const { session: id, data } = e.payload;
        if (!term) return;
        if (id === session || (id === backend?.pending && !session)) term.write(data);
        else if (!session) early.set(id, [...(early.get(id) ?? []), data]);
      }),
      events.execClosed(thisWindow()).listen((e) => {
        if (!term) return;
        // Keep `session`: a failure message can arrive just after the close,
        // and the output handler drops messages for a session it no longer
        // knows.
        if (e.payload === session) term.write(closedNote);
        else if (!session) closedEarly.add(e.payload);
      }),
    ]);
    if (destroyed) {
      un.forEach((f) => f());
      return;
    }
    unlisteners = un;

    try {
      lastSize = `${t.cols}x${t.rows}`;
      const { id, intro, kubectl } = await b.start(t.cols, t.rows);
      if (destroyed) {
        b.close(id).catch(() => {});
        return;
      }
      session = id;
      if (target.kind === "local") localKubectl = kubectl ?? "";
      if (intro) t.write(intro);
      for (const data of early.get(id) ?? []) t.write(data);
      if (closedEarly.has(id)) t.write(closedNote);
      early = new Map();
      closedEarly = new Set();
      sendResize();
      // In order: concurrent input calls can overtake each other.
      t.onData(orderedInput((data) => b.input(id, data)));
      if (active) t.focus();
    } catch (e) {
      t.write("\r\n\x1b[31mCould not open terminal: " + e + "\x1b[0m\r\n");
    }
  });

  onDestroy(() => {
    destroyed = true;
    unregisterSearch();
    resizeObserver?.disconnect();
    unlisteners.forEach((f) => f());
    if (session) backend?.close(session).catch(() => {});
    session = null;
    term?.dispose();
    term = null;
    fit = null;
    search = null;
  });
</script>

<!-- xterm's fit addon sizes the terminal from its parent's computed height
     and width, which with `box-sizing: border-box` include the parent's
     padding and border: the padding stays on the outer box, so the last row
     is not cut in half (#181). -->
<div class="terminal" data-testid="terminal" bind:this={box}>
  {#if search}
    <TerminalSearch bind:this={searchBar} {search} onclose={() => term?.focus()} />
  {/if}
  {#if localKubectl !== null}
    <KubectlOffer used={localKubectl} />
  {/if}
  <div class="screen" bind:this={host}></div>
</div>

<style>
  .terminal {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 8px 12px;
    background: #0d1013;
    border-top: 1px solid var(--border);
    overflow: hidden;
    /* The search bar floats over the top right: opening it never resizes the shell. */
    position: relative;
  }
  .screen {
    flex: 1;
    min-height: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
  }
</style>
