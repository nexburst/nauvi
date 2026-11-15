import { describe, expect, it } from "vitest";
import { pathParts } from "./catalog";

describe("pathParts (#179)", () => {
  it("cuts after each slash and keeps the text", () => {
    const p = "/Users/pedro/.kube/kubeloupe-kind.yaml";
    expect(pathParts(p)).toEqual(["/", "Users/", "pedro/", ".kube/", "kubeloupe-kind.yaml"]);
    expect(pathParts(p).join("")).toBe(p);
  });

  it("handles Windows paths and a trailing separator", () => {
    expect(pathParts("C:\\Users\\me\\.kube\\")).toEqual(["C:\\", "Users\\", "me\\", ".kube\\"]);
  });

  it("leaves a bare name whole", () => {
    expect(pathParts("config")).toEqual(["config"]);
    expect(pathParts("")).toEqual([""]);
  });
});
