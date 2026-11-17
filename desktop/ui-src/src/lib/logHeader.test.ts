import { describe, expect, it } from "vitest";
import { filterSummary, logHeader, timeRange } from "./logHeader";
import type { LogHeaderInfo } from "./logHeader";

const base: LogHeaderInfo = {
  context: "kind-nauvi-test",
  namespace: "demo",
  pod: "web-1",
  container: "app",
  previous: false,
  tail: "200",
  since: "all",
  search: { text: "", regex: false, matchCase: false },
  highlight: false,
  exclude: "",
  contextLines: 0,
  podFilter: "",
  saved: 2,
  buffered: 2,
  texts: ["2026-11-16T10:00:00.123456789Z a", "no time", "2026-11-16T10:05:00Z b"],
  now: new Date("2026-11-17T08:00:00Z"),
};

describe("logHeader (#339)", () => {
  it("names the source, the options, the time range and the filter", () => {
    expect(logHeader(base).split("\n")).toEqual([
      "# nauvi logs",
      "# Context:    kind-nauvi-test",
      "# Namespace:  demo",
      "# Pod:        web-1",
      "# Container:  app",
      "# Requested:  last 200 lines, all time",
      "# Time range: 2026-11-16T10:00:00.123Z to 2026-11-16T10:05:00.000Z",
      "# Filter:     none",
      "# Lines:      2",
      "# Saved:      2026-11-17T08:00:00.000Z",
      "#",
      "",
    ]);
  });

  it("workloads, all containers, previous, since and lines without a time", () => {
    const h = logHeader({
      ...base,
      pod: undefined,
      workload: { kind: "Deployment", name: "web" },
      container: "",
      previous: true,
      tail: "all",
      since: "3600",
      texts: ["plain"],
      saved: 3,
      buffered: 10,
    });
    expect(h).toContain("# Workload:   Deployment/web\n");
    expect(h).toContain("# Container:  all (previous)\n");
    expect(h).toContain("# Requested:  all lines, last 1h\n");
    expect(h).toContain("# Time range: unknown (no timestamps on the lines)\n");
    expect(h).toContain("# Lines:      3 of 10\n");
    expect(h).not.toContain("Pod:");
  });
});

describe("filterSummary", () => {
  it("search, context, exclude and the pod filter", () => {
    expect(
      filterSummary({
        ...base,
        search: { text: "err", regex: true, matchCase: true },
        contextLines: 2,
        exclude: "health",
        podFilter: "web-2",
      }),
    ).toBe('match "err" (regex, match case), 2 lines of context; exclude "health"; pod web-2');
    expect(
      filterSummary({
        ...base,
        search: { text: "x", regex: false, matchCase: false },
        contextLines: 1,
      }),
    ).toBe('match "x" (text, ignore case), 1 line of context');
  });

  it("highlight mode has no context; an exclude alone names its toggles", () => {
    expect(
      filterSummary({
        ...base,
        search: { text: "x", regex: false, matchCase: false },
        highlight: true,
        contextLines: 3,
      }),
    ).toBe('highlight "x" (text, ignore case)');
    expect(filterSummary({ ...base, exclude: "GET /health" })).toBe('exclude "GET /health" (text, ignore case)');
  });
});

describe("timeRange", () => {
  it("is null without times", () => {
    expect(timeRange([])).toBeNull();
    expect(timeRange(["a", "b"])).toBeNull();
  });
});
