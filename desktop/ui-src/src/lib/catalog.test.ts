import { describe, expect, it } from "vitest";
import {
  checkedOnOpen,
  commandsToAsk,
  displayName,
  filterContexts,
  lastUsedText,
  namespaceError,
  orderContexts,
  parseNamespaceList,
  runLimited,
  toggleFavourite,
} from "./catalog";
import type { ContextInfo } from "./bindings";

const ctx = (name: string, extra: Partial<ContextInfo> = {}): ContextInfo => ({
  name,
  context: name,
  current: false,
  namespace: null,
  cluster: `c-${name}`,
  user: "u",
  server: `https://${name}.example`,
  file: "/home/u/.kube/config",
  source: "",
  login_command: "",
  login_plugin: false,
  ...extra,
});

describe("catalog helpers", () => {
  it("checks on open only the contexts that log in without a plugin (#201)", () => {
    const all = [
      ctx("kind"),
      ctx("eks", { login_plugin: true, login_command: "aws eks get-token" }),
      ctx("oidc", { login_plugin: true }),
    ];
    expect(checkedOnOpen(all)).toEqual(["kind"]);
  });

  it("asks only about commands not allowed yet, for the given contexts", () => {
    const cmds = [
      { command: "aws", contexts: ["a", "b"], answer: "unanswered" },
      { command: "gcloud", contexts: ["c"], answer: "allowed" },
      { command: "sh", contexts: ["d"], answer: "denied" },
    ];
    expect(commandsToAsk(cmds).map((c) => c.command)).toEqual(["aws", "sh"]);
    expect(commandsToAsk(cmds, ["b"]).map((c) => c.command)).toEqual(["aws"]);
    expect(commandsToAsk(cmds, ["c"])).toEqual([]);
  });

  it("names a context by its display name, else its id", () => {
    expect(displayName(ctx("prod"), { display_name: "  Production " })).toBe("Production");
    expect(displayName(ctx("prod"), { display_name: "" })).toBe("prod");
    expect(displayName(ctx("prod"), undefined)).toBe("prod");
  });

  it("puts pinned contexts first, in pin order", () => {
    const all = [ctx("a"), ctx("b"), ctx("c"), ctx("d")];
    const { pinned, others } = orderContexts(all, ["c", "gone", "a"]);
    expect(pinned.map((c) => c.name)).toEqual(["c", "a"]);
    expect(others.map((c) => c.name)).toEqual(["b", "d"]);
  });

  it("toggles pins", () => {
    expect(toggleFavourite(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleFavourite(["a", "b"], "a")).toEqual(["b"]);
  });

  it("says when a context was last used", () => {
    const now = 1_000_000_000_000;
    expect(lastUsedText(0, now)).toBe("never");
    expect(lastUsedText(now - 5_000, now)).toBe("just now");
    expect(lastUsedText(now - 5 * 60_000, now)).toBe("5m ago");
    expect(lastUsedText(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(lastUsedText(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("parses and checks namespace lists", () => {
    expect(parseNamespaceList(" team-a, team-b  team-a,,")).toEqual(["team-a", "team-b"]);
    expect(parseNamespaceList("")).toEqual([]);
    expect(namespaceError("team-a")).toBe("");
    expect(namespaceError("Team_A")).toContain("not a valid namespace name");
  });

  it("filters by id, name, server and file", () => {
    const all = [ctx("dev"), ctx("prod (work.yaml)", { file: "/w/work.yaml", context: "prod" })];
    const names = (c: ContextInfo) => (c.name === "dev" ? "Laptop" : c.name);
    expect(filterContexts(all, "laptop", names).map((c) => c.name)).toEqual(["dev"]);
    expect(filterContexts(all, "work.yaml", names).map((c) => c.name)).toEqual(["prod (work.yaml)"]);
    expect(filterContexts(all, "example", names)).toHaveLength(2);
    expect(filterContexts(all, " ", names)).toHaveLength(2);
  });

  it("runs at most `limit` checks at a time", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      running--;
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
