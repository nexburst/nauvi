import { describe, expect, it } from "vitest";
import type { EnvFromGroup, EnvValue } from "./bindings";
import { envCount, envGroupTitle, envTitle, envRowId, envShownValue, envValueSource, MASK, visibleText } from "./podEnv";

const v = (r: Partial<EnvValue>): EnvValue => ({
  name: "X",
  kind: "literal",
  object: "",
  key: "",
  value: "",
  hidden: false,
  error: "",
  overridden: false,
  ...r,
});

const g = (r: Partial<EnvFromGroup>): EnvFromGroup => ({
  kind: "configmap",
  object: "cfg",
  prefix: "",
  optional: false,
  error: "",
  rows: [],
  ...r,
});

describe("env values", () => {
  it("says where a value comes from", () => {
    expect(envValueSource(v({}))).toBe("");
    expect(envValueSource(v({ kind: "configmap", object: "cfg", key: "level" }))).toBe("ConfigMap cfg/level");
    expect(envValueSource(v({ kind: "secret", object: "db", key: "password" }))).toBe("Secret db/password");
    expect(envValueSource(v({ kind: "field", key: "metadata.name" }))).toBe("field metadata.name");
    expect(envValueSource(v({ kind: "resource", key: "limits.cpu" }))).toBe("resource limits.cpu");
  });

  it("titles envFrom groups with prefix and optional", () => {
    expect(envGroupTitle(g({}))).toBe("all of ConfigMap cfg");
    expect(envGroupTitle(g({ kind: "secret", object: "db", prefix: "DB_", optional: true }))).toBe(
      "all of Secret db (prefix DB_, optional)",
    );
  });

  it("masks hidden values and shows references", () => {
    expect(envShownValue(v({ hidden: true, value: "never" }))).toBe(MASK);
    expect(envShownValue(v({ value: "hello" }))).toBe("hello");
    expect(envShownValue(v({ kind: "resource", key: "limits.cpu" }))).toBe("resourceFieldRef(limits.cpu)");
    expect(envShownValue(v({ kind: "field", key: "status.podIP" }))).toBe("fieldRef(status.podIP)");
    expect(envShownValue(v({ kind: "field", key: "metadata.name", value: "web-1" }))).toBe("web-1");
  });

  it("counts what the container sees", () => {
    const groups = [g({ rows: [v({ name: "A" }), v({ name: "B", overridden: true })] })];
    expect(envCount(groups, [v({ name: "B" })])).toBe(2);
    expect(envRowId(0, 1)).not.toBe(envRowId("env", 1));
  });

  it("shows bidi and other invisible characters as escapes", () => {
    const rlo = String.fromCharCode(0x202e);
    expect(visibleText(`abc${rlo}fdp.exe`)).toBe("abc\\u{202E}fdp.exe");
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0xfeff]) {
      expect(visibleText(String.fromCharCode(cp))).toBe(`\\u{${cp.toString(16).toUpperCase()}}`);
    }
    const controls = ["a", "\u0000", "b", "\u001b", "c", "\u007f", "d", "\u0085", "e"].join("");
    expect(visibleText(controls)).toBe("a\\u{0000}b\\u{001B}c\\u{007F}d\\u{0085}e");
    // Newlines and tabs keep a multi-line value's shape; other text is untouched.
    expect(visibleText("a=1\n\tb=2 ünï 日本")).toBe("a=1\n\tb=2 ünï 日本");
  });
});

describe("envTitle (#525)", () => {
  const n = (name: string, source = "") => ({ name, source });
  it("counts plain variables as they are", () => {
    expect(envTitle([n("A"), n("B", "secret:db/password")], null)).toBe("Environment (2)");
  });
  it("counts envFrom sources apart until the values are loaded", () => {
    expect(envTitle([n("A"), n("B"), n("*", "configmap:app-config")], null)).toBe("Environment (2 + 1 source)");
    expect(envTitle([n("*", "configmap:a"), n("DB_*", "secret:b")], null)).toBe("Environment (2 sources)");
  });
  it("shows the loaded number of variables", () => {
    expect(envTitle([n("A"), n("*", "configmap:app-config")], 26)).toBe("Environment (26)");
  });
});
