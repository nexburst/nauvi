import { describe, expect, it } from "vitest";
import { pushTrail, stepId, ticksOf, viewLabel, type Step } from "./trail";

const v = (view: string): Step => ({ view });
const o = (view: string, name: string): Step => ({ view, object: { namespace: "demo", name } });
const ids = (t: Step[]) => t.map(stepId);

describe("the wake", () => {
  it("keeps a view's place when coming back to it", () => {
    let t = pushTrail([], v("overview"));
    t = pushTrail(t, v("v1/pods"));
    t = pushTrail(t, v("overview"));
    expect(ids(t)).toEqual(["overview", "v1/pods"]);
  });

  it("puts an object after its view, so the wake reads as a path", () => {
    let t = [v("overview"), v("v1/pods"), v("apps/v1/deployments")];
    t = pushTrail(t, o("v1/pods", "crashed"));
    t = pushTrail(t, o("v1/pods", "web-1"));
    expect(ids(t)).toEqual(["overview", "v1/pods", "v1/pods|demo/crashed", "v1/pods|demo/web-1", "apps/v1/deployments"]);
    expect(ids(pushTrail(t, o("v1/pods", "crashed")))).toEqual(ids(t));
  });

  it("drops the oldest spine beyond the limit, never the new one", () => {
    let t: Step[] = [];
    for (const name of ["a", "b", "c", "d"]) t = pushTrail(t, v(name), 3);
    expect(ids(t)).toEqual(["b", "c", "d"]);
    expect(ids(pushTrail(t, v(""), 3))).toEqual(ids(t));
    expect(ids(pushTrail([v("a"), v("b")], o("a", "x"), 2))).toEqual(["a|demo/x", "b"]);
  });

  it("names kinds by their label and the other views by name", () => {
    const kinds = [{ id: "v1/pods", label: "Pods" }];
    expect(viewLabel("v1/pods", kinds)).toBe("Pods");
    expect(viewLabel("overview", kinds)).toBe("Overview");
    expect(viewLabel("helm", kinds)).toBe("Releases");
    expect(viewLabel("x/unknown", kinds)).toBe("x/unknown");
  });

  it("draws a tick per row: coral for trouble, amber for waiting", () => {
    const row = (name: string, problem: string, cells: string[] = []) => ({ namespace: "demo", name, problem, status: "", cells });
    const ticks = ticksOf([row("a", "CrashLoopBackOff"), row("b", "Pending for 60m"), row("c", "", ["Running"]), row("d", "", ["Pending"])]);
    expect(ticks.map((t) => t.tone)).toEqual(["bad", "warn", "ok", "warn"]);
    expect(ticksOf(Array.from({ length: 300 }, (_, i) => row(String(i), "")))).toHaveLength(120);
  });
});
