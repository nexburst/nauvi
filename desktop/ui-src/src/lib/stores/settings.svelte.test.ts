import { describe, expect, it, vi } from "vitest";

// cmd_update_settings answers only when the test says so.
const pending: (() => void)[] = [];
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
invoke.mockImplementation((cmd: string) =>
  cmd === "cmd_update_settings" ? new Promise<null>((resolve) => pending.push(() => resolve(null))) : Promise.resolve(null),
);

const { settingsSaved, updateContext, contextSettings } = await import("./settings.svelte");

describe("settingsSaved", () => {
  it("waits until the backend has every change sent so far (#327)", async () => {
    let saved = false;
    void updateContext("kind", { hide_metrics: true });
    void updateContext("kind", { color: "#ef4444" });
    // The UI has the change at once.
    expect(contextSettings("kind").hide_metrics).toBe(true);
    void settingsSaved().then(() => (saved = true));
    await Promise.resolve();
    expect(saved).toBe(false);
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toBe(false);
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toBe(true);
  });
});
