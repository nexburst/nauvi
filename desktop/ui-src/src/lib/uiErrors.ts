// Errors the UI catches go to the app log (#208): a `<svelte:boundary>`
// (Boundary.svelte), `onerror` and unhandled promise rejections. The
// backend masks secret-looking text and caps their number and length;
// this side caps how often it sends, so a loop that throws stays cheap.

import { commands } from "./bindings";

/** Where an error was caught. */
export type UiErrorSource = "boundary" | "error" | "rejection";

/** At most this many errors per `WINDOW_MS` are sent. */
export const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
/** Longer messages and stacks are cut (the backend cuts them too). */
const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;

/** The message and stack of anything thrown. */
export function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    const message = error.message ? `${error.name}: ${error.message}` : error.name;
    return { message: message.slice(0, MAX_MESSAGE), stack: (error.stack ?? "").slice(0, MAX_STACK) };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { message: message.slice(0, MAX_MESSAGE), stack: "" };
}

/** A sliding-window limit: `take()` is true at most `max` times per `windowMs`. */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  let times: number[] = [];
  return {
    take(): boolean {
      const t = now();
      times = times.filter((x) => t - x < windowMs);
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
  };
}

const limit = rateLimiter(MAX_PER_WINDOW, WINDOW_MS);
let last = "";

/** Send `error` to the app log (never throws). */
export function reportUiError(source: UiErrorSource, error: unknown): void {
  const { message, stack } = describeError(error);
  // The same error again and again (a render loop) is logged once.
  const key = `${source}\n${message}`;
  if (key === last || !limit.take()) return;
  last = key;
  try {
    void commands.cmdLogUiError(source, message, stack).catch(() => {});
  } catch {
    /* no backend (tests without one) */
  }
}

/** Forward the window's uncaught errors and unhandled rejections. */
export function forwardUiErrors(root: Window): void {
  root.addEventListener("error", (e) => reportUiError("error", e.error ?? e.message));
  root.addEventListener("unhandledrejection", (e) => reportUiError("rejection", e.reason));
}
