// An access check that answers after the window switched cluster is about
// the old one: it is dropped (#349).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionAccess } from "./bindings";

const state = vi.hoisted(() => ({
  visible: "a",
  answer: null as null | ((list: ActionAccess[]) => void),
}));

vi.mock("./cluster", () => ({
  visibleCluster: () => state.visible,
  api: () => ({
    cmdCheckActions: () =>
      new Promise<ActionAccess[]>((resolve) => {
        state.answer = resolve;
      }),
  }),
}));

import { deleteDenied, deniedActions } from "./access";

const pods = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };
const refused: ActionAccess[] = [
  { id: "delete", allowed: false, reason: "Not allowed: you can't delete pods in namespace demo" },
];

describe("deniedActions across a context switch", () => {
  beforeEach(() => {
    state.visible = "a";
    state.answer = null;
  });

  it("keeps an answer about the cluster still shown", async () => {
    const out = deniedActions(pods, "demo", ["delete"]);
    state.answer!(refused);
    expect([...(await out)]).toEqual([["delete", refused[0].reason]]);
  });

  it("drops an answer that arrives after a switch", async () => {
    const out = deniedActions(pods, "demo", ["delete"]);
    state.visible = "b";
    state.answer!(refused);
    expect((await out).size).toBe(0);
  });

  it("the keyboard Delete's check too", async () => {
    const out = deleteDenied(pods, [{ namespace: "demo" }]);
    await Promise.resolve();
    state.visible = "b";
    state.answer!(refused);
    expect(await out).toBe("");
  });
});
