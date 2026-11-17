import { describe, expect, it } from "vitest";
import type { UpdateCheck } from "./bindings";
import { checkSummary, formatMB, progressLabel, progressPercent, showsBanner } from "./updates";

const check = (change: Partial<UpdateCheck> = {}): UpdateCheck => ({
  status: "available",
  current_version: "0.1.0",
  version: "0.2.0",
  notes: "",
  release_url: "https://github.com/nexburst/nauvi/releases/tag/v0.2.0",
  can_install: true,
  note: "",
  ...change,
});

describe("progress", () => {
  it("is a percentage once the size is known", () => {
    expect(progressPercent({ phase: "downloading", downloaded: 0, total: 0 })).toBeNull();
    expect(progressPercent({ phase: "downloading", downloaded: 4_500_000, total: 10_000_000 })).toBe(45);
    expect(progressPercent({ phase: "downloading", downloaded: 11, total: 10 })).toBe(100);
    expect(progressPercent({ phase: "installing", downloaded: 0, total: 0 })).toBe(100);
  });

  it("says what is happening", () => {
    expect(progressLabel({ phase: "downloading", downloaded: 0, total: 0 })).toBe("Downloading…");
    expect(progressLabel({ phase: "downloading", downloaded: 2_500_000, total: 0 })).toBe("Downloading… 2.5 MB");
    expect(progressLabel({ phase: "downloading", downloaded: 6_100_000, total: 13_500_000 })).toBe(
      "Downloading… 45% (6.1 of 13.5 MB)",
    );
    expect(progressLabel({ phase: "installing", downloaded: 1, total: 1 })).toBe("Installing…");
  });

  it("formats megabytes", () => {
    expect(formatMB(0)).toBe("0.0 MB");
    expect(formatMB(13_456_789)).toBe("13.5 MB");
  });
});

describe("checkSummary", () => {
  it("describes each result", () => {
    expect(checkSummary(check())).toBe("nauvi 0.2.0 is available (you have 0.1.0).");
    expect(checkSummary(check({ status: "up_to_date", version: "" }))).toBe("nauvi 0.1.0 is the latest version.");
    expect(checkSummary(check({ status: "skipped", note: "Development builds do not check." }))).toBe(
      "Development builds do not check.",
    );
  });
});

describe("showsBanner", () => {
  it("shows a newer version until it is dismissed", () => {
    expect(showsBanner(null, "")).toBe(false);
    expect(showsBanner(check(), "")).toBe(true);
    expect(showsBanner(check(), "0.2.0")).toBe(false);
    // A later version shows again.
    expect(showsBanner(check({ version: "0.3.0" }), "0.2.0")).toBe(true);
    expect(showsBanner(check({ status: "up_to_date" }), "")).toBe(false);
    expect(showsBanner(check({ status: "skipped" }), "")).toBe(false);
  });
});
