import { describe, expect, it } from "vitest";
import type { ResourceKind } from "./bindings";
import { absentTitle, EXPECTED_KINDS, missingKinds } from "./sidebarExpected";

function served(group: string, kind: string): ResourceKind {
  return { resource: { group, kind } } as unknown as ResourceKind;
}

describe("missingKinds", () => {
  it("lists every expected kind when none is served", () => {
    expect(missingKinds("devices", []).map((e) => e.kind)).toEqual([
      "DeviceClass",
      "ResourceClaim",
      "ResourceClaimTemplate",
      "ResourceSlice",
    ]);
  });

  it("leaves out the served ones, by group and kind", () => {
    const kinds = [
      served("resource.k8s.io", "DeviceClass"),
      served("example.com", "ResourceClaim"),
    ];
    expect(missingKinds("devices", kinds).map((e) => e.kind)).toEqual([
      "ResourceClaim",
      "ResourceClaimTemplate",
      "ResourceSlice",
    ]);
  });

  it("has nothing to add for groups without expected kinds", () => {
    expect(missingKinds("workloads", [])).toEqual([]);
  });

  it("says why an absent kind is greyed out", () => {
    expect(absentTitle(EXPECTED_KINDS.devices![0])).toBe(
      "Device Classes: this cluster does not serve DeviceClass (resource.k8s.io)",
    );
  });
});
