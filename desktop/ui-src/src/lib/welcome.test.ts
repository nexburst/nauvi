import { describe, expect, it } from "vitest";
import type { SourceInfo } from "./bindings";
import {
  addedSources,
  isNoKubeconfig,
  lookedAt,
  MISSING_FILE,
  nextSteps,
  noContexts,
  noContextsStatus,
  shouldWelcome,
  tips,
} from "./welcome";

const source = (s: Partial<SourceInfo>): SourceInfo => ({
  path: "/home/me/.kube/config",
  kind: "kubeconfig",
  contexts: 0,
  files: 0,
  error: "",
  ...s,
});

describe("welcome", () => {
  it("shows on a first run and whenever there is no context, in the main window only", () => {
    expect(shouldWelcome(false, 1, true)).toBe(true);
    expect(shouldWelcome(true, 0, true)).toBe(true);
    expect(shouldWelcome(true, 3, true)).toBe(false);
    expect(shouldWelcome(false, 0, false)).toBe(false);
  });

  it("says what each default kubeconfig file held", () => {
    const looked = lookedAt([
      source({ error: "the file does not exist" }),
      source({ path: "/k/b.yaml", contexts: 1, files: 1 }),
      source({ path: "/k/c.yaml", contexts: 3, files: 1 }),
      source({ path: "/k/added.yaml", kind: "file", contexts: 2 }),
    ]);
    expect(looked).toEqual([
      { path: "/home/me/.kube/config", found: "the file does not exist", ok: false },
      { path: "/k/b.yaml", found: "1 context", ok: true },
      { path: "/k/c.yaml", found: "3 contexts", ok: true },
    ]);
    expect(addedSources([source({}), source({ kind: "folder", path: "/k/" })]).map((s) => s.path)).toEqual(["/k/"]);
  });

  it("tells a missing kubeconfig from one that cannot be read or has no context", () => {
    expect(noContexts([])).toBe("reading");
    expect(noContexts([source({ error: MISSING_FILE }), source({ path: "/b", error: MISSING_FILE })])).toBe("missing");
    expect(noContexts([source({ error: MISSING_FILE }), source({ path: "/b", error: "Cannot use the kubeconfig: bad YAML" })])).toBe(
      "unreadable",
    );
    expect(noContexts([source({ files: 1 })])).toBe("empty");
    expect(noContextsStatus("missing")).toBe("No kubeconfig");
    expect(noContextsStatus("unreadable")).toBe("Kubeconfig error");
    expect(noContextsStatus("empty")).toBe("No contexts");
    expect(noContextsStatus("reading")).toBeNull();
    expect(isNoKubeconfig("Could not discover the cluster's resource types: No kubeconfig found (looked at /x; KUBECONFIG is not set).")).toBe(true);
    expect(isNoKubeconfig("Cannot use the kubeconfig: bad YAML")).toBe(false);
  });

  it("names the platform's keys", () => {
    expect(nextSteps(false).map((s) => s.keys)).toEqual(["Ctrl+K", "l", "s"]);
    expect(nextSteps(true)[0].keys).toBe("⌘K");
    expect(tips(false).map((t) => t.keys)).toEqual(["g", "Ctrl+K", "/", "?"]);
  });
});
