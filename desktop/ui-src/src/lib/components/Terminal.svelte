<script module lang="ts">
  import { commands } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import type { ClusterApi } from "../cluster";
  import type { PodRef } from "../stores/detail.svelte";
  import { orderedInput } from "../orderedInput";
  import { kubectlIntro } from "../kubectlMatch";
  import type { TermMessage } from "../bindings";
  import type { Channel } from "@tauri-apps/api/core";

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

  /** The session commands of a target. Every kind streams to the channel
   *  `start` gets (#115): output as raw bytes, then `closed`. */
  interface Backend {
    /** The session id, and a note to show before the shell's output. */
    start(
      cols: number,
      rows: number,
      out: Channel<TermMessage>,
    ): Promise<{ id: string; intro: string; kubectl?: string }>;
    /** `clear`: drop the output still waiting first (a Ctrl-C at a shell). */
    input(id: string, data: string, clear: boolean): Promise<unknown>;
    /** The tab wrote (or dropped) `bytes` of the output: the backend may send that much more. */
    ack(id: string, bytes: number): Promise<unknown>;
    resize(id: string, cols: number, rows: number): Promise<unknown>;
    close(id: string): Promise<unknown>;
  }

  function randomId(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function backendFor(t: TerminalTarget, c: ClusterApi): Backend {
    if (t.kind === "debug" || t.kind === "nodeShell") {
      const pending = `ui-${randomId()}`;
      return {
        start: async (cols, rows, out) => ({
          id:
            t.kind === "debug"
              ? await c.cmdDebugStart(pending, t.pod.namespace, t.pod.name, t.target, t.image, cols, rows, out)
              : await c.cmdNodeShellStart(pending, t.node, t.namespace, cols, rows, out),
          intro: "",
        }),
        input: c.cmdExecInput,
        ack: c.cmdExecAck,
        resize: c.cmdExecResize,
        close: c.cmdExecClose,
      };
    }
    if (t.kind === "pod" || t.kind === "attach") {
      const start = t.kind === "pod" ? c.cmdExecStart : c.cmdAttachStart;
      return {
        start: async (cols, rows, out) => ({
          id: await start(t.pod.namespace, t.pod.name, t.container, cols, rows, out),
          intro: "",
        }),
        input: c.cmdExecInput,
        ack: c.cmdExecAck,
        resize: c.cmdExecResize,
        close: c.cmdExecClose,
      };
    }
    return {
      start: async (cols, rows, out) => {
        const s = await c.cmdLocalShellStart(t.namespace, cols, rows, out);
        return {
          id: s.session,
          intro:
            `\x1b[90mLocal shell: kubectl uses context ${s.context}, namespace ${s.namespace}.\r\n` +
            "Changing the app's namespace or context does not change this shell.\x1b[0m\r\n" +
            kubectlIntro(s.kubectl),
          kubectl: s.kubectl,
        };
      },
      input: c.cmdLocalShellInput,
      ack: c.cmdLocalShellAck,
      resize: c.cmdLocalShellResize,
      close: c.cmdLocalShellClose,
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
  import { INTERRUPT, TermWriter, termChannel } from "../termOutput";

  /** Bytes written before they are acknowledged in one call (#115). */
  const ACK_EVERY = 256 * 1024;
  import { settings } from "../stores/settings.svelte";
  import KubectlOffer from "./KubectlOffer.svelte";

  interface Props {
    target: TerminalTarget;
    /** The shown dock tab: it gets the focus. Hidden tabs keep their session. */
    active?: boolean;
    /** The cluster it runs on (ADR 0007): by default the one shown. */
    cluster?: string;
  }

  let { target, active = true, cluster = visibleCluster() }: Props = $props();

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
  let destroyed = false;
  /** Writes the session's output into xterm, a frame at a time (#115). */
  let writer: TermWriter | null = null;
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
    const b = backendFor(target, api(cluster));
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

    // The session's own channel (#115): what arrives on it is ours, in
    // order, also before `start` resolves (progress while a debug container
    // or node shell pod starts, an attach note). xterm gets it once per
    // frame, a bounded amount at a time, so a flood never keeps the page
    // from drawing or taking keys.
    // What was written (or dropped) is acknowledged, so the backend sends at
    // most a window ahead: in steps of ACK_EVERY, or when nothing waits
    // (fewer calls under a flood). Before `start` resolves it is owed.
    let unacked = 0;
    const ack = () => {
      if (!session || unacked === 0) return;
      b.ack(session, unacked).catch(() => {});
      unacked = 0;
    };
    const w = new TermWriter((data, done) => (term ? term.write(data, done) : done()), {
      onConsumed: (n) => {
        unacked += n;
        if (unacked >= ACK_EVERY || w.pending === 0) ack();
      },
    });
    writer = w;
    // A local shell's intro (from `start`'s answer) goes before its prompt.
    if (target.kind === "local") w.pause();
    // After Ctrl-C, what was already on its way is stale: dropped (and
    // acknowledged) until the backend's `cleared` says the rest is new.
    let stale = false;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    const out = termChannel({
      output: (bytes) => (stale ? w.discard(bytes.length) : w.push(bytes, true)),
      event: (e) => {
        if (e.type === "closed") w.push(closedNote);
        else if (e.type === "cleared") {
          stale = false;
          clearTimeout(staleTimer);
        }
      },
    });

    try {
      lastSize = `${t.cols}x${t.rows}`;
      const { id, intro, kubectl } = await b.start(t.cols, t.rows, out);
      if (destroyed) {
        b.close(id).catch(() => {});
        return;
      }
      session = id;
      ack();
      if (target.kind === "local") localKubectl = kubectl ?? "";
      if (intro) t.write(intro);
      w.resume();
      sendResize();
      // In order: concurrent input calls can overtake each other.
      // `clear` rides with the next call, so the backend drops its backlog
      // before the keys reach the shell (and not the output they cause).
      let clearNext = false;
      const send = orderedInput((data: string) => {
        const clear = clearNext;
        clearNext = false;
        return b.input(id, data, clear);
      });
      t.onData((data) => {
        // A lone Ctrl-C at a shell drops the backlog here and in the
        // backend. Not a paste that holds one, and not in a full-screen app
        // (vim, less +F), whose screen the dropped output would leave half
        // drawn. Should `cleared` never come (the session ended), stop
        // dropping anyway.
        if (data === INTERRUPT && t.buffer.active.type === "normal") {
          clearNext = true;
          w.clear();
          stale = true;
          clearTimeout(staleTimer);
          staleTimer = setTimeout(() => (stale = false), 3000);
        }
        send(data);
      });
      if (active) t.focus();
    } catch (e) {
      // After what the start wrote (its progress).
      w.push("\r\n\x1b[31mCould not open terminal: " + e + "\x1b[0m\r\n");
      w.resume();
    }
  });

  onDestroy(() => {
    destroyed = true;
    unregisterSearch();
    resizeObserver?.disconnect();
    writer?.dispose();
    writer = null;
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
