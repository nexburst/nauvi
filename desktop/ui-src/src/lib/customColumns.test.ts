import { describe, expect, it } from "vitest";
import type { CustomColumn, ResourceKind } from "./bindings";
import {
  customColumnError,
  customFor,
  customKey,
  customSignature,
  fieldPathError,
  isCustomKey,
  newCustomId,
  SECRET_DATA_REFUSED,
  sourceError,
  withCustom,
} from "./customColumns";
import { columnsFor } from "./columns";

const col = (id: string, more: Partial<CustomColumn> = {}): CustomColumn => ({
  id,
  label: `Col ${id}`,
  source: "label",
  value: "app",
  context: "",
  ...more,
});

const KIND: ResourceKind = {
  resource: { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true },
  id: "v1/pods",
  label: "Pods",
  category: "workloads",
  crd: false,
  verbs: [],
  short_names: [],
  columns: [{ key: "name", label: "Name", kind: "text", default_hidden: false }],
  actions: [],
};

describe("field paths (#547)", () => {
  it("take dotted names and number indexes", () => {
    expect(fieldPathError(".spec.priorityClassName")).toBe("");
    expect(fieldPathError(" .status.podIP ")).toBe("");
    expect(fieldPathError(".spec.containers[0].image")).toBe("");
    expect(fieldPathError(".spec.containers[ 1 ]")).toBe("");
    expect(fieldPathError(".metadata.owner_ref-x")).toBe("");
  });

  it("say what is wrong in plain words, like the backend", () => {
    expect(fieldPathError("")).toBe("Type a field path, for example .spec.priorityClassName.");
    expect(fieldPathError("spec.x")).toMatch(/^A field path starts with a dot/);
    expect(fieldPathError(".")).toMatch(/^A field name must follow the first dot/);
    expect(fieldPathError(".spec..x")).toBe('A field name is missing after ".spec.".');
    expect(fieldPathError(".spec.")).toBe('A field name is missing after ".spec.".');
    expect(fieldPathError(".spec.containers[*]")).toContain('"[*]" is not supported');
    expect(fieldPathError(".a[?(@.b==1)]")).toContain("not supported");
    expect(fieldPathError(".a[0")).toContain("not closed");
    expect(fieldPathError(".metadata.labels.app/name")).toMatch(/^"\/" cannot be in a field name.*Label or Annotation/);
    expect(fieldPathError(".a b")).toMatch(/^A space cannot be/);
    expect(fieldPathError("." + "a".repeat(300))).toContain("too long");
  });

  it("label and annotation keys have no spaces", () => {
    expect(sourceError("label", "app.kubernetes.io/version")).toBe("");
    expect(sourceError("annotation", "")).toMatch(/^Type the annotation key/);
    expect(sourceError("label", "a b")).toBe("A label key has no spaces.");
  });
});

describe("custom columns on Secrets (#571)", () => {
  const secret = { group: "", kind: "Secret" };
  it("never read their data", () => {
    for (const path of [".data", ".data.password", " .data.x ", ".data[0]", ".Data.x", ".stringData", ".stringdata.t"])
      expect(sourceError("field", path, secret), path).toBe(SECRET_DATA_REFUSED);
    for (const key of ["kubectl.kubernetes.io/last-applied-configuration", "Kapp.k14s.io/Original"])
      expect(sourceError("annotation", key, secret), key).toBe(SECRET_DATA_REFUSED);
    // A wrong path says what is wrong with it first.
    expect(sourceError("field", ".['data']", secret)).toMatch(/^A field name must follow the first dot/);
    expect(sourceError("field", ".metadata['data']", secret)).toMatch(/Only numbers work in brackets/);
    expect(sourceError("field", "data", secret)).toMatch(/starts with a dot/);
    // The rest of a Secret, and other kinds, are fine.
    for (const path of [".type", ".dataset", ".data-x", ".metadata.name", ".immutable"])
      expect(sourceError("field", path, secret), path).toBe("");
    expect(sourceError("label", "kubectl.kubernetes.io/last-applied-configuration", secret)).toBe("");
    expect(sourceError("field", ".data.x", { group: "", kind: "ConfigMap" })).toBe("");
    expect(sourceError("field", ".data.x", { group: "example.com", kind: "Secret" })).toBe("");
    expect(customColumnError({ label: "Password", source: "field", value: ".data.password" }, ["Name"], secret)).toBe(
      SECRET_DATA_REFUSED,
    );
  });
});

describe("custom columns", () => {
  it("need a name of their own", () => {
    const c = { label: "Version", source: "label" as const, value: "app.kubernetes.io/version" };
    expect(customColumnError(c, ["Name", "Status"])).toBe("");
    expect(customColumnError({ ...c, label: "  " }, [])).toBe("Give the column a name.");
    expect(customColumnError({ ...c, label: "status" }, ["Name", "Status"])).toBe(
      'The table already has a column named "status".',
    );
    expect(customColumnError({ ...c, label: "x".repeat(65) }, [])).toContain("too long");
    expect(customColumnError({ ...c, source: "field", value: "spec" }, [])).toMatch(/starts with a dot/);
  });

  it("get ids of their own", () => {
    expect(newCustomId([])).toBe("c1");
    expect(newCustomId([col("c2")])).toBe("c3");
    expect(newCustomId([col("c1"), col("c3")])).toBe("c4");
    expect(customKey("c1")).toBe("custom:c1");
    expect(isCustomKey("custom:c1") && !isCustomKey("image")).toBe(true);
  });

  it("of a CRD's kind apply in the context they were added in", () => {
    const all = [col("a"), col("b", { context: "prod" }), col("c", { context: "dev" })];
    expect(customFor(all, { crd: false }, "dev").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(customFor(all, { crd: true }, "dev").map((c) => c.id)).toEqual(["a", "c"]);
    expect(customFor(undefined, { crd: true }, "dev")).toEqual([]);
  });

  it("come after the kind's own, as plain text columns with the name as typed", () => {
    expect(withCustom(KIND, [])).toBe(KIND);
    const kind = withCustom(KIND, [col("v", { label: "App Version" })]);
    expect(kind.columns.map((c) => c.key)).toEqual(["name", "custom:v"]);
    // The same object for the same columns, so its columns stay cached.
    expect(withCustom(KIND, [col("v", { label: "App Version" })])).toBe(kind);
    expect(withCustom(KIND, [col("v", { label: "Other" })])).not.toBe(kind);
    const [, custom] = columnsFor(kind);
    expect(custom.label).toBe("App Version");
    const row = { key: "a", name: "a", namespace: "", created: 0, cells: ["a", "1.2"], status: "", problem: "" };
    expect(custom.text(row, { metrics: { pods: new Map(), nodes: new Map(), sparks: new Map(), since: 0 }, now: 0 })).toBe(
      "1.2",
    );
  });

  it("restart the watch only when what is read changes", () => {
    const a = customSignature([col("v")]);
    expect(customSignature([col("v", { label: "Renamed" })])).toBe(a);
    expect(customSignature([col("v", { value: "tier" })])).not.toBe(a);
    expect(customSignature([col("v", { source: "annotation" })])).not.toBe(a);
  });
});
