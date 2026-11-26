import { describe, expect, it } from "vitest";
import { emptyState, type EmptyInput } from "./emptyState";
import { PROBLEMS_STATUS } from "./workloads";

const base: EmptyInput = {
  label: "Deployments",
  plural: "deployments",
  group: "apps",
  namespaced: true,
  verbs: ["list", "watch", "create"],
  namespaces: [],
  search: "",
  status: "",
  total: 0,
  synced: true,
  denied: false,
};
const ids = (i: Partial<EmptyInput>) => emptyState({ ...base, ...i }).actions.map((a) => a.id);

describe("emptyState", () => {
  it("says the filter hides the rows, and offers to clear it", () => {
    const e = emptyState({ ...base, search: "checkout", total: 3 });
    expect(e.reason).toBe("filter");
    expect(e.title).toBe('No Deployments match "checkout"');
    expect(e.detail).toBe("The filter hides all 3. It stays on as you go from table to table.");
    expect(ids({ search: "checkout", total: 3 })).toEqual(["clearFilter"]);
    expect(emptyState({ ...base, search: "x", total: 1, namespaces: ["demo"] }).detail).toContain(
      "hides the only one in namespace demo",
    );
  });

  it("with no rows at all, the filter is not the reason", () => {
    expect(emptyState({ ...base, search: "checkout", namespaces: ["demo"] }).reason).toBe("namespace");
  });

  it("an empty namespace offers all namespaces and Create", () => {
    const e = emptyState({ ...base, namespaces: ["empty-ns"] });
    expect(e.title).toBe("No Deployments in namespace empty-ns");
    expect(ids({ namespaces: ["empty-ns"] })).toEqual(["allNamespaces", "create"]);
    expect(emptyState({ ...base, namespaces: ["a", "b"] }).title).toBe("No Deployments in namespaces a and b");
  });

  it("a kind that cannot be created offers no Create", () => {
    expect(ids({ verbs: ["list"] })).toEqual([]);
    expect(emptyState({ ...base, verbs: ["list"] }).title).toBe("No Deployments in any namespace");
    expect(
      emptyState({ ...base, label: "Nodes", plural: "nodes", group: "", namespaced: false, namespaces: ["demo"] }).title,
    ).toBe("No Nodes in this cluster");
  });

  it("says which verb and resource are not allowed, and where", () => {
    const e = emptyState({ ...base, label: "Secrets", plural: "secrets", group: "", denied: true, namespaces: ["team-b"] });
    expect(e.reason).toBe("denied");
    expect(e.title).toBe("No access to Secrets in namespace team-b");
    expect(e.detail).toContain('may not "list" secrets in namespace team-b');
    expect(emptyState({ ...base, denied: true }).detail).toContain(
      'may not "list" deployments.apps across all namespaces. Pick a namespace',
    );
  });

  it("the status filters say what they hide", () => {
    expect(emptyState({ ...base, status: PROBLEMS_STATUS, total: 4 })).toMatchObject({
      reason: "status",
      title: "No Deployments need attention",
      detail: "All 4 are fine.",
    });
    expect(emptyState({ ...base, status: "Failed", total: 2 }).title).toBe("No Deployments with status Failed");
  });

  it("says it is loading before the first rows", () => {
    expect(emptyState({ ...base, synced: false, search: "x" }).reason).toBe("loading");
  });
});
