import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheck } from "../bindings";

// The automatic update check (#540): on start, every 12 h (± 1 h) and on a
// wake, from the main window, while the setting is on.

const HOUR = 3_600_000;

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const main = vi.hoisted(() => ({ is: true }));
vi.mock("../window", () => ({ isMainWindow: () => main.is, thisWindow: () => ({ label: main.is ? "main" : "w2" }) }));

/** What the next `cmd_update_check` answers: a version, or an error to throw. */
let answer: { version?: string; error?: string; skipped?: boolean } = {};
const checks: boolean[] = [];

function result(): UpdateCheck {
  const base = {
    current_version: "0.3.1",
    notes: "",
    release_url: "https://example.invalid/release",
    can_install: true,
    note: "",
    update_command: "",
  };
  if (answer.skipped) return { ...base, status: "skipped", version: "", note: "turned off" };
  if (answer.version) return { ...base, status: "available", version: answer.version };
  return { ...base, status: "up_to_date", version: "" };
}

invoke.mockImplementation(async (cmd: string, args?: { startup?: boolean }) => {
  if (cmd === "cmd_update_check") {
    checks.push(!!args?.startup);
    if (answer.error) throw answer.error;
    return result();
  }
  return null;
});

const store = await import("./updates.svelte");
const { updates, startupCheck, stopAutoChecks, dismissUpdate, checkForUpdates } = store;
const { settings } = await import("./settings.svelte");
const { showsBanner } = await import("../updates");

/** A window and document whose events the test sends. */
function targets() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  return { win, doc };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const banner = () => showsBanner(updates.check, updates.dismissed);

let t: ReturnType<typeof targets>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  t = targets();
  vi.stubGlobal("window", t.win);
  vi.stubGlobal("document", t.doc);
  main.is = true;
  answer = {};
  checks.length = 0;
  settings.current = { ...settings.current, check_updates: true };
  updates.check = null;
  updates.dismissed = "";
  updates.checkError = "";
});

afterEach(() => {
  stopAutoChecks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the automatic update check", () => {
  it("finds a release published after start within 13 h", async () => {
    await startupCheck();
    expect(checks).toEqual([true]);
    expect(banner()).toBe(false);

    answer = { version: "0.4.0" };
    await vi.advanceTimersByTimeAsync(11 * HOUR - 1_000);
    expect(checks).toEqual([true]);
    await vi.advanceTimersByTimeAsync(2 * HOUR + 1_000);
    expect(checks).toEqual([true, true]);
    expect(banner()).toBe(true);

    // And again about 12 h later.
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toEqual([true, true, true]);
  });

  it("a failed periodic check stays quiet and the next one tries again", async () => {
    await startupCheck();
    answer = { error: "Could not check for updates: offline" };
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toHaveLength(2);
    expect(updates.announce).toBe(false);
    answer = { version: "0.4.0" };
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toHaveLength(3);
    expect(banner()).toBe(true);
  });

  it("a dismissed version stays dismissed; a newer one shows again", async () => {
    answer = { version: "0.4.0" };
    await startupCheck();
    expect(banner()).toBe(true);
    dismissUpdate();
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toHaveLength(2);
    expect(banner()).toBe(false);
    answer = { version: "0.5.0" };
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(banner()).toBe(true);
  });

  it("a wake checks once when the last check is more than 12 h old", async () => {
    await startupCheck();
    // A wake soon after a check asks nothing.
    t.win.dispatchEvent(new Event("online"));
    await flush();
    expect(checks).toHaveLength(1);

    // The machine sleeps 20 h: timers stand still, the clock does not.
    vi.setSystemTime(20 * HOUR);
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(checks).toHaveLength(2);
    // Online, then the late tick: the same wake, no second check.
    await vi.advanceTimersByTimeAsync(6_000);
    t.win.dispatchEvent(new Event("online"));
    await flush();
    expect(checks).toHaveLength(2);
  });

  it("turned off: no periodic or wake check; turned on again: checks if due, then periodically", async () => {
    await startupCheck();
    settings.current = { ...settings.current, check_updates: false };
    await flush();
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    vi.setSystemTime(60 * HOUR);
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(checks).toEqual([true]);

    settings.current = { ...settings.current, check_updates: true };
    await flush();
    expect(checks).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toEqual([true, true, true]);
  });

  it("turned on soon after a check waits for the timer", async () => {
    await startupCheck();
    settings.current = { ...settings.current, check_updates: false };
    await flush();
    settings.current = { ...settings.current, check_updates: true };
    await flush();
    expect(checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(checks).toHaveLength(2);
  });

  it("off on start: the skipped check does not count, so turning it on checks at once", async () => {
    settings.current = { ...settings.current, check_updates: false };
    answer = { skipped: true };
    await startupCheck();
    expect(checks).toEqual([true]);
    answer = { version: "0.4.0" };
    settings.current = { ...settings.current, check_updates: true };
    await flush();
    expect(checks).toEqual([true, true]);
    expect(banner()).toBe(true);
  });

  it("a second window never checks", async () => {
    main.is = false;
    await startupCheck();
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    vi.setSystemTime(60 * HOUR);
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(checks).toEqual([]);
  });

  it("a check from Settings counts as the last check for a wake", async () => {
    await startupCheck();
    vi.setSystemTime(13 * HOUR);
    await checkForUpdates(false);
    t.win.dispatchEvent(new Event("online"));
    await flush();
    expect(checks).toEqual([true, false]);
  });
});
