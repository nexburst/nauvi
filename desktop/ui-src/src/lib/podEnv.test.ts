import { describe, expect, it } from "vitest";
import type { EnvFromGroup, EnvValue } from "./bindings";
import { envCount, envGroupTitle, envRowId, envShownValue, envValueSource, MASK } from "./podEnv";

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
});
