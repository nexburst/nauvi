import { describe, expect, it, vi } from "vitest";
import bindingsSource from "./bindings.ts?raw";

const invoke = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve(null)));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { api, CANCELLED, GLOBAL_COMMANDS, MUTATING_COMMANDS, isClusterCommand, setMutationGuard } = await import(
  "./cluster"
);
const { commands } = await import("./bindings");

/** Each command of `bindings.ts` with its parameter names, in order. */
function parameters(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of bindingsSource.matchAll(/^\t(cmd\w+): \((.*)\) => __TAURI_INVOKE/gm)) {
    const names = m[2]
      .split(/,(?![^<{]*[>}])/)
      .map((p) => p.trim().split(/\??:/)[0])
      .filter((n) => n && n !== "options");
    out.set(m[1], names);
  }
  return out;
}

describe("the cluster contract (ADR 0007)", () => {
  const params = parameters();

  it("reads every command of bindings.ts", () => {
    expect(params.size).toBe(Object.keys(commands).length);
  });

  it("puts cluster first wherever a command takes it", () => {
    const wrong = [...params].filter(([, p]) => p.includes("cluster") && p[0] !== "cluster").map(([n]) => n);
    expect(wrong).toEqual([]);
    const mutating = new Set<string>(MUTATING_COMMANDS);
    for (const m of bindingsSource.matchAll(/^\t(cmd\w+): \(cluster: (\w+)/gm)) {
      expect(m[2], m[1]).toBe(mutating.has(m[1]) ? "MutationTarget" : "string");
    }
  });

  it("lists exactly the commands behind the read-only / protected gate as mutating (#338)", () => {
    const gated = [...bindingsSource.matchAll(/^\t(cmd\w+): \(cluster: MutationTarget/gm)].map((m) => m[1]);
    expect([...MUTATING_COMMANDS]).toEqual([...MUTATING_COMMANDS].sort());
    expect(gated.sort()).toEqual([...MUTATING_COMMANDS]);
  });

  it("lists exactly the commands without cluster as global", () => {
    const without = [...params].filter(([, p]) => p[0] !== "cluster").map(([n]) => n);
    expect([...GLOBAL_COMMANDS]).toEqual([...GLOBAL_COMMANDS].sort());
    expect(without.sort()).toEqual([...GLOBAL_COMMANDS]);
    for (const [name, p] of params) expect(isClusterCommand(name), name).toBe(p[0] === "cluster");
  });

  it("api(id) sends id as the cluster", async () => {
    await api("kind-dev").cmdListNamespaces();
    await api("prod").cmdExecInput("exec-1", "x");
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual(["cmd_list_namespaces", { cluster: "kind-dev" }]);
    expect(invoke.mock.calls[1].slice(0, 2)).toEqual(["cmd_exec_input", { cluster: "prod", session: "exec-1", data: "x" }]);
    expect(api("prod")).toBe(api("prod"));
    expect("cmdGetSettings" in api("prod")).toBe(false);
  });

  it("asks the guard for a mutating call's cluster, and stops when it is cancelled", async () => {
    invoke.mockClear();
    const seen: unknown[] = [];
    setMutationGuard(async (id, command, args) => {
      seen.push([id, command, args]);
      return args[1] === "keep" ? { id, confirm: "prod" } : null;
    });
    const ref = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };
    await api("prod").cmdDeleteResource(ref, "keep", "web");
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual([
      "cmd_delete_resource",
      { cluster: { id: "prod", confirm: "prod" }, resource: ref, namespace: "keep", name: "web" },
    ]);
    await expect(api("prod").cmdDeleteResource(ref, "other", "web")).rejects.toBe(CANCELLED);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["prod", "cmdDeleteResource", [ref, "keep", "web"]]);
    // Other commands never ask.
    await api("prod").cmdListNamespaces();
    expect(seen).toHaveLength(2);
    setMutationGuard(async (id) => id);
  });
});
