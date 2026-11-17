import { describe, expect, it } from "vitest";
import { describeMutation, isDryRun, modeLabel, modeTitle } from "./contextMode";
import { MUTATING_COMMANDS } from "./cluster";

const pod = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };

describe("context modes (#338)", () => {
  it("labels only the modes that limit changes", () => {
    expect(modeLabel("normal")).toBe("");
    expect(modeLabel(undefined)).toBe("");
    expect(modeLabel("readOnly")).toBe("Read-only");
    expect(modeLabel("protected")).toBe("Protected");
    expect(modeTitle("readOnly", "prod")).toContain("prod is read-only");
    expect(modeTitle("normal", "prod")).toBe("");
  });

  it("reads dry runs from the arguments the backend reads", () => {
    expect(isDryRun("cmdApplyResourceYaml", [pod, "demo", "web", "yaml", "1", true])).toBe(true);
    expect(isDryRun("cmdApplyResourceYaml", [pod, "demo", "web", "yaml", "1", false])).toBe(false);
    expect(isDryRun("cmdApplyManifests", ["yaml", "demo", true, false])).toBe(true);
    expect(isDryRun("cmdApplyManifests", ["yaml", "demo", false, true])).toBe(false);
    expect(isDryRun("cmdHelmInstall", [{ dry_run: true }])).toBe(true);
    expect(isDryRun("cmdHelmUpgrade", [{ dry_run: false }])).toBe(false);
    expect(isDryRun("cmdMetricsAddonInstall", [{ dry_run: true }])).toBe(true);
    expect(isDryRun("cmdDeleteResource", [pod, "demo", "web"])).toBe(false);
  });

  it("says what each change does", () => {
    expect(describeMutation("cmdDeleteResource", [pod, "demo", "web"])).toBe("Delete Pod demo/web");
    expect(describeMutation("cmdRunAction", [pod, "demo", "web", "restart", null])).toBe("Restart Pod demo/web");
    expect(describeMutation("cmdRunAction", [pod, "demo", "web", "forceDelete", null])).toBe("Force delete Pod demo/web");
    expect(describeMutation("cmdExecStart", ["demo", "web", null, 80, 24])).toBe("Open a shell in pod demo/web");
    expect(describeMutation("cmdDrainNode", ["node-1", 60])).toBe("Drain node node-1");
    for (const c of MUTATING_COMMANDS) expect(describeMutation(c, []), c).toBeTruthy();
  });
});
