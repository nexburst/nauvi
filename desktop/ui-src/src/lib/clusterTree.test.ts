import { describe, expect, it } from "vitest";
import type { ContextInfo, ResourceKind } from "./bindings";
import { baseName, groupContexts, sectionsOf, stateText } from "./clusterTree";

function ctx(name: string, source = "", file = "/home/u/.kube/config"): ContextInfo {
  return {
    name,
    context: name,
    current: false,
    namespace: null,
    cluster: name,
    user: "u",
    server: "https://x:6443",
    file,
    source,
    login_command: "",
    login_plugin: false,
    local_files: [],
  };
}

function kind(id: string, category: ResourceKind["category"]): ResourceKind {
  return { id, category } as ResourceKind;
}

describe("groupContexts", () => {
  it("puts the default kubeconfig first, then the added sources in catalog order", () => {
    const groups = groupContexts([
      ctx("a", "/x/team.yaml", "/x/team.yaml"),
      ctx("kind"),
      ctx("b", "/y/folder", "/y/folder/one.yaml"),
      ctx("c", "/x/team.yaml", "/x/team.yaml"),
      ctx("prod", "", "/etc/other"),
    ]);
    expect(groups.map((g) => [g.label, g.contexts.map((c) => c.name)])).toEqual([
      ["Kubeconfig", ["kind", "prod"]],
      ["team.yaml", ["a", "c"]],
      ["folder", ["b"]],
    ]);
    expect(groups[0].title).toBe("/home/u/.kube/config\n/etc/other");
    expect(groups[1].title).toBe("/x/team.yaml");
  });

  it("has no groups without contexts", () => {
    expect(groupContexts([])).toEqual([]);
  });
});

describe("baseName", () => {
  it("takes the last part of a path", () => {
    expect(baseName("/a/b/team.yaml")).toBe("team.yaml");
    expect(baseName("C:\\Users\\me\\kube\\dev.yaml")).toBe("dev.yaml");
    expect(baseName("/a/folder/")).toBe("folder");
  });
});

describe("sectionsOf", () => {
  it("groups kinds by sidebar section, in sidebar order, without empty ones", () => {
    const s = sectionsOf([kind("v1/services", "network"), kind("v1/pods", "workloads"), kind("x/v1/foos", "custom")]);
    expect(s.map((x) => [x.title, x.kinds.map((k) => k.id)])).toEqual([
      ["Workloads", ["v1/pods"]],
      ["Network", ["v1/services"]],
      ["Custom Resources", ["x/v1/foos"]],
    ]);
  });
});

describe("stateText", () => {
  it("says what each state means", () => {
    expect(stateText("idle", true)).toBe("Shown in this window");
    expect(stateText("idle", false)).toMatch(/expand to connect/);
    expect(stateText("connected", false)).toMatch(/keep running/);
  });
});
