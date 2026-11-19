import { describe, expect, it } from "vitest";
import { blips, fleet, problemTone } from "./sonar";

describe("sonar", () => {
  const crashed = { namespace: "demo", name: "crashed", reason: "CrashLoopBackOff", status: "CrashLoopBackOff" };
  const pending = { namespace: "demo", name: "db-0", reason: "Pending for 60m", status: "Pending" };

  it("puts errors on the inner ring and the rest further out", () => {
    expect(problemTone(crashed)).toBe("error");
    expect(problemTone(pending)).toBe("warn");
    expect(problemTone({ reason: "Pending", status: "Pending" })).toBe("warn");
    const [e, w] = blips([crashed, pending], 100);
    expect(Math.hypot(e.x, e.y)).toBeLessThan(45);
    expect(Math.hypot(w.x, w.y)).toBeGreaterThan(55);
  });

  it("keeps a pod at the same bearing across updates", () => {
    const a = blips([crashed, pending], 100).find((b) => b.key === "demo/crashed");
    const b = blips([crashed], 100)[0];
    expect(b).toEqual(a);
  });

  it("caps the fleet and keeps it on the outer ring", () => {
    expect(fleet(500, 100)).toHaveLength(48);
    expect(fleet(3, 100)).toHaveLength(3);
    for (const d of fleet(20, 100)) expect(Math.hypot(d.x, d.y)).toBeGreaterThan(80);
  });
});
