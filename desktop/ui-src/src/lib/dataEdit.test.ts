import { describe, expect, it } from "vitest";
import { changesOf, draftId, isBase64, keyError, sizeText, summaryOf, withValue } from "./dataEdit";
import type { Edit } from "./dataEdit";

const entry = { key: "password", field: "data" as const };

describe("withValue", () => {
  it("records an edit and drops it when the original comes back", () => {
    const orig = { value: "hunter2", encoding: "text" as const };
    let edits = withValue(new Map(), entry, "hunter3", "text", orig);
    expect(edits.get("password")).toEqual({ field: "data", value: "hunter3", encoding: "text", delete: false, added: false });
    edits = withValue(edits, entry, "hunter2", "text", orig);
    expect(edits.size).toBe(0);
  });

  it("keeps an edit when the original is unknown", () => {
    expect(withValue(new Map(), entry, "x", "text", null).size).toBe(1);
  });

  it("keeps an added key added", () => {
    const start = new Map<string, Edit>([["new", { field: "data", value: "", encoding: "text", delete: false, added: true }]]);
    const edits = withValue(start, { key: "new", field: "data" }, "", "text", { value: "", encoding: "text" });
    expect(edits.get("new")?.added).toBe(true);
  });
});

describe("changesOf", () => {
  it("sends only edited keys, sorted, without values for removals", () => {
    const edits = new Map<string, Edit>([
      ["b", { field: "data", value: "old", encoding: "text", delete: true, added: false }],
      ["a", { field: "binaryData", value: "AAEC", encoding: "base64", delete: false, added: false }],
      ["gone", { field: "data", value: "x", encoding: "text", delete: true, added: true }],
    ]);
    expect(changesOf(edits)).toEqual([
      { key: "a", field: "binaryData", delete: false, value: "AAEC", encoding: "base64" },
      { key: "b", field: "data", delete: true, value: "", encoding: "text" },
    ]);
    expect(summaryOf(edits)).toBe("1 changed, 1 added, 1 removed");
  });
});

describe("validation", () => {
  it("checks base64", () => {
    expect(isBase64("aHVudGVyMg==")).toBe(true);
    expect(isBase64("aHVu dGVy\nMg==")).toBe(true);
    expect(isBase64("abc")).toBe(false);
    expect(isBase64("not base64!")).toBe(false);
  });

  it("checks keys", () => {
    const taken = new Set(["a"]);
    expect(keyError("tls.crt", taken)).toBe("");
    expect(keyError("", taken)).toMatch(/Enter/);
    expect(keyError("a", taken)).toMatch(/exists/);
    expect(keyError("a b", taken)).toMatch(/" " is not allowed/);
    expect(keyError("..", taken)).toMatch(/not a valid/);
    expect(keyError("x".repeat(254), taken)).toMatch(/253/);
  });

  it("formats sizes", () => {
    expect(sizeText(1)).toBe("1 byte");
    expect(sizeText(7)).toBe("7 bytes");
    expect(sizeText(2048)).toBe("2.0 KiB");
  });
});

describe("draftId", () => {
  it("differs per context for the same object", () => {
    const t = { resource: { group: "", kind: "Secret" }, namespace: "demo", name: "db-creds" };
    expect(draftId("kind-dev", t)).toBe("data|kind-dev|/Secret|demo/db-creds");
    expect(draftId("prod", t)).not.toBe(draftId("kind-dev", t));
  });
});
