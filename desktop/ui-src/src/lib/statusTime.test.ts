import { describe, expect, it } from "vitest";
import { becameLive, statusTimeLabel } from "./statusTime";

const t = (ms: number) => `T${ms}`;

describe("statusTimeLabel", () => {
  it("is empty before the view has data", () => {
    expect(statusTimeLabel({ ok: true, text: "Live" }, 0, t)).toBe("");
  });

  it("says Live and when the rows last changed while connected", () => {
    expect(statusTimeLabel({ ok: true, text: "Live" }, 5, t)).toBe("Live · last change T5");
  });

  it("says Stale since while not connected", () => {
    expect(statusTimeLabel({ ok: false, text: "Reconnecting…" }, 5, t)).toBe("Stale since T5");
    expect(statusTimeLabel({ ok: false, text: "Not connected" }, 5, t)).toBe("Stale since T5");
  });

  it("says Updated for polled kinds and views that load once", () => {
    expect(statusTimeLabel({ ok: null, text: "Not live: refreshed every 30 s" }, 5, t)).toBe("Updated T5");
    expect(statusTimeLabel({ ok: true, text: "Loaded" }, 5, t)).toBe("Updated T5");
  });
});

describe("becameLive", () => {
  const live = { ok: true, text: "Live" };
  it("is true when a view connects or reconnects", () => {
    expect(becameLive({ ok: null, text: "Connecting…" }, live)).toBe(true);
    expect(becameLive({ ok: false, text: "Reconnecting…" }, live)).toBe(true);
  });
  it("is false while it stays live or is not live", () => {
    expect(becameLive(live, live)).toBe(false);
    expect(becameLive(live, { ok: false, text: "Reconnecting…" })).toBe(false);
    expect(becameLive({ ok: null, text: "Connecting…" }, { ok: null, text: "Connecting…" })).toBe(false);
  });
});
