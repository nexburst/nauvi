<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { placeTip, tipDelay } from "../tooltip";

  /**
   * One tooltip for the whole window (#483): any element's `title` shows
   * here, styled like the app, after a short wait under the pointer or at
   * once on keyboard focus.
   *
   * While the tip shows under the pointer, the element's `title` is set to
   * "" (the old one kept in `data-tip-title`), so the engine does not show
   * its own as well; it is put back when the tip hides. An element named
   * only by its title (no aria-label, no text) gets it as its aria-label
   * meanwhile, so its accessible name never goes. If the page changes the
   * title meanwhile (Svelte sets a new one or removes it), that change
   * wins: nothing is put back.
   */

  const STASH = "data-tip-title";

  let text = $state("");
  let pos = $state({ x: -9999, y: -9999 });
  let tipEl = $state<HTMLDivElement | null>(null);
  /** The element the tip is (or will be) for. */
  let anchor: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHidden = 0;
  /** The element whose title is set aside, and whether we gave it an aria-label. */
  let stashed: { el: Element; labelled: boolean } | null = null;
  /** Watches the set-aside title for changes made by the page. */
  const observer = new MutationObserver(() => {
    if (!stashed) return;
    // Someone else wrote the title: theirs stands, ours is dropped.
    const el = stashed.el;
    el.removeAttribute(STASH);
    if (stashed.labelled) el.removeAttribute("aria-label");
    stashed = null;
    observer.disconnect();
    if (el === anchor) hideTip();
  });

  const titled = (t: EventTarget | null): Element | null =>
    t instanceof Element ? t.closest(`[title]:not([title=""])`) : null;

  const tipText = (el: Element) => el.getAttribute(STASH) ?? el.getAttribute("title") ?? "";

  function stash(el: Element) {
    const t = el.getAttribute("title");
    if (t === null || t === "" || stashed) return;
    const labelled = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim();
    if (labelled) el.setAttribute("aria-label", t);
    el.setAttribute(STASH, t);
    el.setAttribute("title", "");
    stashed = { el, labelled };
    observer.observe(el, { attributes: true, attributeFilter: ["title"] });
  }

  function restore() {
    if (!stashed) return;
    observer.takeRecords();
    observer.disconnect();
    const { el, labelled } = stashed;
    stashed = null;
    const t = el.getAttribute(STASH);
    el.removeAttribute(STASH);
    if (labelled) el.removeAttribute("aria-label");
    if (t !== null && el.getAttribute("title") === "") el.setAttribute("title", t);
  }

  function hideTip() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (text) lastHidden = Date.now();
    text = "";
    pos = { x: -9999, y: -9999 };
  }

  /** Hide the tip; the pointer stays on `anchor`, so it shows again only on another element. */
  function hide() {
    restore();
    hideTip();
  }

  function show(el: Element, delay: number, setAside: boolean) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (anchor !== el || !el.isConnected) return;
      const t = tipText(el);
      if (!t) return;
      if (setAside) stash(el);
      text = t;
    }, delay);
  }

  // Placed once its size is known.
  $effect(() => {
    if (!text || !tipEl || !anchor) return;
    if (!anchor.isConnected) {
      queueMicrotask(leave);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const p = placeTip(r, { width: tipEl.offsetWidth, height: tipEl.offsetHeight }, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    pos = { x: p.x, y: p.y };
  });

  function leave() {
    hide();
    anchor = null;
    dismissed = false;
  }

  /** A click put the tip of `anchor` away: it waits for the pointer to leave it. */
  let dismissed = false;

  // Driven by the pointer's own moves, not by `pointerover`: that one also
  // fires when the page changes under a pointer at rest (a row opening, a
  // list re-rendering), and a tip should not pop up then.
  function onmove(e: PointerEvent) {
    const el = titled(e.target) ?? (stashed && e.target instanceof Node && stashed.el.contains(e.target) ? stashed.el : null);
    if (el && el === anchor && anchor.isConnected) {
      if (!text && !timer && !dismissed) show(el, tipDelay(Date.now(), lastHidden), true);
      return;
    }
    leave();
    if (!el) return;
    anchor = el;
    show(el, tipDelay(Date.now(), lastHidden), true);
  }

  function ondown() {
    dismissed = true;
    hide();
  }

  function onfocusin(e: FocusEvent) {
    const el = e.target instanceof Element ? e.target : null;
    // Only keyboard focus: a click focuses too, and the pointer is there already.
    if (!el || !el.matches(":focus-visible")) return;
    if (!el.getAttribute(STASH) && !el.getAttribute("title")) return;
    queueMicrotask(() => {
      if (anchor && anchor !== el) leave();
      anchor = el;
      // The title stays: it is the accessible name of some buttons.
      show(el, 0, false);
    });
  }

  // Focus moves synchronously while Svelte removes a focused element, in
  // the middle of an update: the state changes wait for it to end.
  function onfocusout(e: FocusEvent) {
    const el = e.target;
    queueMicrotask(() => {
      if (el === anchor) leave();
    });
  }

  // Only a scroll that moves the anchor hides the tip (not a log or a
  // table scrolling elsewhere in the window).
  function onscroll(e: Event) {
    const t = e.target;
    if (!anchor || !text) return;
    if (t === document || (t instanceof Node && t.contains(anchor))) hide();
  }

  const onkey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && text) hide();
  };

  onMount(() => {
    document.addEventListener("pointermove", onmove, true);
    document.addEventListener("pointerdown", ondown, true);
    document.addEventListener("focusin", onfocusin, true);
    document.addEventListener("focusout", onfocusout, true);
    document.addEventListener("keydown", onkey, true);
    document.addEventListener("scroll", onscroll, true);
    document.documentElement.addEventListener("pointerleave", leave);
  });
  onDestroy(() => {
    document.removeEventListener("pointermove", onmove, true);
    document.removeEventListener("pointerdown", ondown, true);
    document.removeEventListener("focusin", onfocusin, true);
    document.removeEventListener("focusout", onfocusout, true);
    document.removeEventListener("keydown", onkey, true);
    document.removeEventListener("scroll", onscroll, true);
    document.documentElement.removeEventListener("pointerleave", leave);
    leave();
    observer.disconnect();
  });
</script>

{#if text}
  <div
    class="tip"
    role="tooltip"
    data-testid="tooltip"
    bind:this={tipEl}
    style:left="{pos.x}px"
    style:top="{pos.y}px"
  >
    {text}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 1000;
    max-width: 340px;
    padding: 5px 9px;
    background: var(--bg-raised);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: var(--shadow-pop);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 400;
    line-height: 1.4;
    white-space: pre-line;
    overflow-wrap: anywhere;
    pointer-events: none;
    animation: tip-in 120ms var(--ease-out);
  }
  @keyframes tip-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
</style>
