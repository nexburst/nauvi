import { describe, expect, it } from "vitest";
import { rolloutLook, rolloutRank, rolloutTitle, rolloutTone } from "./rolloutStatus";

describe("rollout status", () => {
  it("gives each word the container squares' shape and tone", () => {
    expect(rolloutLook("Running")).toBe("ok");
    expect(rolloutLook("Scaling")).toBe("warn");
    expect(rolloutLook("Updating")).toBe("warn");
    expect(rolloutLook("Failed")).toBe("bad");
    expect(rolloutLook("Scaled down")).toBe("done");
    expect(rolloutLook("Paused")).toBe("done");
    expect(rolloutLook("Something new")).toBe("unknown");
    expect(rolloutLook("constructor")).toBe("unknown");
    expect(rolloutTone("Failed")).toBe("bad");
    expect(rolloutTone("Scaled down")).toBe("muted");
  });

  it("sorts broken first when descending", () => {
    const words = ["Running", "Failed", "", "Scaling", "Scaled down", "Updating"];
    const sorted = [...words].sort((a, b) => rolloutRank(b) - rolloutRank(a));
    expect(sorted).toEqual(["Failed", "Updating", "Scaling", "Scaled down", "Running", ""]);
  });

  it("explains the word, with the row's problem when it has one", () => {
    expect(rolloutTitle("Failed", "Rollout stalled (ProgressDeadlineExceeded)")).toBe(
      "Failed: Rollout stalled (ProgressDeadlineExceeded)",
    );
    expect(rolloutTitle("Running", "")).toBe("Running: every wanted pod is there and ready");
    expect(rolloutTitle("Odd", "")).toBe("Odd");
    expect(rolloutTitle("", "")).toBe("");
  });
});
