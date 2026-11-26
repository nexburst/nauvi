import { describe, expect, it } from "vitest";
import { pillText, pillTitle, problemLine } from "./problemPill";

describe("the problem pill", () => {
  it("counts problem pods in plain words", () => {
    expect(pillText(0)).toBe("No problems");
    expect(pillText(1)).toBe("1 problem pod");
    expect(pillText(4)).toBe("4 problem pods");
  });

  it("says what a click shows", () => {
    expect(pillTitle(4)).toBe("4 pods need a look. Click to see them.");
    expect(pillTitle(1)).toBe("1 pod needs a look. Click to see it.");
    expect(pillTitle(0)).toContain("watch log");
  });

  it("gives one line of reason per pod", () => {
    expect(problemLine({ reason: "CrashLoopBackOff", restarts: 6 })).toBe("CrashLoopBackOff · 6 restarts");
    expect(problemLine({ reason: "Pending for 2m", restarts: 0 })).toBe("Pending for 2m");
    expect(problemLine({ reason: "Error", restarts: 1 })).toBe("Error · 1 restart");
  });
});
