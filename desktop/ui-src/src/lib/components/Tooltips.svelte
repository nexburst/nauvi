<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { placeTip, tipDelay } from "../tooltip";

  /**
   * One tooltip for the whole window (#483): any element's `title` shows
   * here, styled like the app, after a short wait under the pointer or at
   * once on keyboard focus. While the pointer is on the element its
   * `title` is set aside (in `data-tip-title`), so the engine does not
   * show its own as well; it is put back when the pointer leaves.
   */

  const STASH = "data-tip-title";

  let text = $state("");
  let pos = $state({ x: -9999, y: -9999 });
  let tipEl = $state<HTMLDivElement | null>(null);
  /** The element the tip is (or will be) for. */
  let anchor: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHidden = 0;

  const titled = (t: EventTarget | null): Element | null =>
    t instanceof Element ? t.closest(`[title]:not([title=""]), [${STASH}]`) : null;

  const tipText = (el: Element) => el.getAttribute(STASH) ?? el.getAttribute("title") ?? "";

  function stash(el: Element) {
    const t = el.getAttribute("title");
    if (t === null || t === "") return;
    el.setAttribute(STASH, t);
    el.removeAttribute("title");
  }

  function restore(el: Element) {
    const t = el.getAttribute(STASH);
    if (t === null) return;
    el.removeAttribute(STASH);
    // Svelte may have set a new title meanwhile: that one wins.
    if (!el.hasAttribute("title")) el.setAttribute("title", t);
  }

  function hide() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (text) lastHidden = Date.now();
    text = "";
    pos = { x: -9999, y: -9999 };
  }

  function show(el: Element, delay: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (anchor !== el || !el.isConnected) return;
      const t = tipText(el);
      if (!t) return;
      text = t;
    }, delay);
  }

  // Placed once its size is known.
  $effect(() => {
    if (!text || !tipEl || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const p = placeTip(r, { width: tipEl.offsetWidth, height: tipEl.offsetHeight }, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    pos = { x: p.x, y: p.y };
  });

  function leave() {
    if (anchor) restore(anchor);
    anchor = null;
    hide();
  }

  function onover(e: PointerEvent) {
    const el = titled(e.target);
    if (el === anchor) return;
    leave();
    if (!el) return;
    anchor = el;
    stash(el);
    show(el, tipDelay(Date.now(), lastHidden));
  }

  function onfocusin(e: FocusEvent) {
    const el = e.target instanceof Element ? e.target : null;
    // Only keyboard focus: a click focuses too, and the pointer is there already.
    if (!el || !el.matches(":focus-visible")) return;
    const t = el.getAttribute("title") ?? el.getAttribute(STASH);
    if (!t) return;
    if (anchor && anchor !== el) leave();
    anchor = el;
    show(el, 0);
  }

  function onfocusout(e: FocusEvent) {
    if (e.target === anchor && !(e.target as Element).hasAttribute(STASH)) leave();
  }

  const onkey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && text) hide();
  };

  onMount(() => {
    document.addEventListener("pointerover", onover, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onfocusin, true);
    document.addEventListener("focusout", onfocusout, true);
    document.addEventListener("keydown", onkey, true);
    document.addEventListener("scroll", hide, true);
    document.documentElement.addEventListener("pointerleave", leave);
  });
  onDestroy(() => {
    document.removeEventListener("pointerover", onover, true);
    document.removeEventListener("pointerdown", hide, true);
    document.removeEventListener("focusin", onfocusin, true);
    document.removeEventListener("focusout", onfocusout, true);
    document.removeEventListener("keydown", onkey, true);
    document.removeEventListener("scroll", hide, true);
    document.documentElement.removeEventListener("pointerleave", leave);
    leave();
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
