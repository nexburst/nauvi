import { describe, expect, it } from "vitest";
import { clampIdleMinutes, clusterStateText, idleChoiceLabel, IDLE_CHOICES, pinsText } from "./idle";

describe("idle disconnect helpers (#333)", () => {
  it("labels the choices, never last", () => {
    expect(IDLE_CHOICES.map(idleChoiceLabel)).toEqual([
      "1 minute",
      "5 minutes",
      "10 minutes",
      "30 minutes",
      "1 hour",
      "Never",
    ]);
    expect(idleChoiceLabel(120)).toBe("2 hours");
    expect(idleChoiceLabel(7)).toBe("7 minutes");
  });

  it("keeps the minutes in range", () => {
    expect(clampIdleMinutes(0)).toBe(0);
    expect(clampIdleMinutes(-3)).toBe(10);
    expect(clampIdleMinutes(Number.NaN)).toBe(10);
    expect(clampIdleMinutes(1e9)).toBe(1440);
    expect(clampIdleMinutes(4.6)).toBe(5);
  });

  it("says what keeps a cluster connected", () => {
    expect(pinsText([])).toBe("");
    expect(pinsText(["drain"])).toBe("a drain");
    expect(pinsText(["port-forward", "terminal", "log-stream"])).toBe("a port-forward, a terminal and a log stream");
    expect(clusterStateText({ state: "connected", pinnedBy: [] })).toBe("Connected.");
    expect(clusterStateText({ state: "connected", pinnedBy: ["browser-login"] })).toBe(
      "Connected, kept by its browser login.",
    );
    expect(clusterStateText({ state: "idle", pinnedBy: [] })).toMatch(/^Disconnected while idle/);
    expect(clusterStateText({ state: "disconnected", pinnedBy: [] })).toBe("Disconnected.");
  });
});
