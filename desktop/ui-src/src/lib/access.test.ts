import { describe, expect, it } from "vitest";
import { deniedReasons, firstDenied, namespacesOf } from "./access";

describe("access", () => {
  it("keeps only the refused actions, with their reasons", () => {
    const out = deniedReasons([
      { id: "logs", allowed: true, reason: "" },
      {
        id: "delete",
        allowed: false,
        reason: "Not allowed: you can't delete pods in namespace demo",
      },
    ]);
    expect([...out]).toEqual([["delete", "Not allowed: you can't delete pods in namespace demo"]]);
  });

  it("lists each namespace once", () => {
    expect(namespacesOf([{ namespace: "a" }, { namespace: "b" }, { namespace: "a" }])).toEqual(["a", "b"]);
    expect(namespacesOf([{ namespace: "" }])).toEqual([""]);
  });

  it("a bulk action is refused when any namespace refuses it", () => {
    expect(firstDenied([undefined, "", "no in b", "no in c"])).toBe("no in b");
    expect(firstDenied([undefined, ""])).toBe("");
    expect(firstDenied([])).toBe("");
  });
});
