import { describe, expect, it } from "vitest";
import { badgeTitle, countProblems, overviewBadges, scopeText } from "./problems";
import type { Badge } from "./problems";

describe("problem badges", () => {
  it("count the rows the backend marked", () => {
    const rows = ["", "CrashLoopBackOff", "", "1 of 3 ready"].map((problem) => ({ row: { problem } }));
    expect(countProblems(rows)).toBe(2);
    expect(countProblems([])).toBe(0);
  });

  it("say which namespaces were counted", () => {
    expect(scopeText(true, [])).toBe("across all namespaces");
    expect(scopeText(true, ["demo", "web"])).toBe("in demo, web");
    expect(scopeText(false, ["demo"])).toBe("");
  });

  it("take Pods and Nodes from the overview, narrowed or not", () => {
    expect(overviewBadges({ namespace: null, problems_total: 2 }, { total: 3, ready: 2 })).toEqual([
      { kindId: "v1/pods", count: 2, scope: "across all namespaces" },
      { kindId: "v1/nodes", count: 1, scope: "" },
    ]);
    // Forbidden parts are left out; a narrowed pod count names its namespace.
    expect(overviewBadges({ namespace: "team-a", problems_total: 0 }, null)).toEqual([
      { kindId: "v1/pods", count: 0, scope: "in team-a" },
    ]);
  });

  it("titles say how many, where, and how old a stale count is", () => {
    const b: Badge = { count: 1, scope: "in demo", source: "table", live: true, at: 0 };
    expect(badgeTitle(b, "Pods", 0)).toBe("1 Pod needs attention in demo");
    expect(badgeTitle({ ...b, count: 3, scope: "" }, "Nodes", 0)).toBe("3 Nodes need attention");
    expect(badgeTitle({ ...b, count: 1 }, "Network Policies", 0)).toBe("1 Network Policy needs attention in demo");
    expect(badgeTitle({ ...b, live: false, at: 0 }, "Pods", 5 * 60_000)).toBe(
      "1 Pod needs attention in demo (when last watched, 5m ago; open the view to update)",
    );
    expect(badgeTitle({ ...b, live: false, at: 0 }, "Pods", 1000)).toContain("just now");
  });
});
