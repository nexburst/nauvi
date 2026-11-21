import { describe, expect, it } from "vitest";
import { containersSummary, lookTone, parseContainers, squareText, worstRank } from "./containerStates";

describe("parseContainers", () => {
  it("reads init containers first, then containers, with their states", () => {
    const sq = parseContainers("init:setup=done app=ready sidecar=waiting:CrashLoopBackOff slow=running");
    expect(sq.map((s) => [s.name, s.init, s.state, s.reason, s.look])).toEqual([
      ["setup", true, "done", "", "done"],
      ["app", false, "ready", "", "ok"],
      ["sidecar", false, "waiting", "CrashLoopBackOff", "bad"],
      ["slow", false, "running", "", "warn"],
    ]);
  });

  it("a waiting reason that is only starting is amber, a failure red", () => {
    expect(parseContainers("a=waiting:ContainerCreating")[0].look).toBe("warn");
    expect(parseContainers("a=waiting")[0].look).toBe("warn");
    const [f] = parseContainers("a=failed:OOMKilled:137");
    expect([f.look, f.reason, f.exit]).toEqual(["bad", "OOMKilled", 137]);
    expect(parseContainers("a=failed::2")[0]).toMatchObject({ reason: "", exit: 2 });
  });

  it("skips what it cannot read and treats an unknown state as no status", () => {
    expect(parseContainers("")).toEqual([]);
    expect(parseContainers("  =ready broken")).toEqual([]);
    expect(parseContainers("a=sleeping")[0]).toMatchObject({ state: "unknown", look: "unknown" });
  });

  it("colours as the detail panel does", () => {
    expect(["ok", "warn", "bad", "done", "unknown"].map((l) => lookTone(l as never))).toEqual([
      "ok",
      "warn",
      "bad",
      "muted",
      "muted",
    ]);
  });
});

describe("text", () => {
  it("names the container, its state and reason", () => {
    const [init, app, side, oom] = parseContainers(
      "init:setup=done app=ready sidecar=waiting:CrashLoopBackOff db=failed:OOMKilled:137",
    );
    expect(squareText(init)).toBe("init container setup: completed");
    expect(squareText(app)).toBe("app: running, ready");
    expect(squareText(side)).toBe("sidecar: waiting, CrashLoopBackOff");
    expect(squareText(oom)).toBe("db: terminated with an error, OOMKilled, exit 137");
  });

  it("summarises every container for screen readers", () => {
    expect(containersSummary(parseContainers("app=ready"))).toBe("1 container: app: running, ready");
    expect(containersSummary(parseContainers("a=ready b=unknown"))).toBe(
      "2 containers: a: running, ready; b: no status yet",
    );
    expect(containersSummary([])).toBe("No containers");
  });
});

describe("worstRank", () => {
  it("sorts by the worst container, then how many are in that state", () => {
    const r = (cell: string) => worstRank(parseContainers(cell));
    expect(r("a=ready b=ready")).toBeLessThan(r("a=done"));
    expect(r("init:i=done a=ready")).toBeLessThan(r("a=running"));
    expect(r("a=running")).toBeLessThan(r("a=ready b=waiting:CrashLoopBackOff"));
    expect(r("a=failed:Error:1")).toBeLessThan(r("a=failed:Error:1 b=waiting:ErrImagePull"));
    expect(r("")).toBeLessThan(r("a=ready"));
  });
});
