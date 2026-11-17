import { describe, expect, it } from "vitest";
import { backgroundClusters, clusterStateChanged, clusterStates } from "./clusterStates.svelte";

describe("background cluster states (#333)", () => {
  it("keeps the last report per cluster, without the visible one", () => {
    clusterStateChanged({
      cluster: "b",
      state: "connected",
      pinnedBy: ["port-forward"],
    });
    clusterStateChanged({ cluster: "a", state: "connected", pinnedBy: [] });
    clusterStateChanged({ cluster: "a", state: "idle", pinnedBy: [] });
    expect(backgroundClusters("x").map((c) => [c.cluster, c.state])).toEqual([
      ["a", "idle"],
      ["b", "connected"],
    ]);
    expect(backgroundClusters("a").map((c) => c.cluster)).toEqual(["b"]);
    clusterStateChanged({ cluster: "b", state: "disconnected", pinnedBy: [] });
    expect([...clusterStates.byId.keys()]).toEqual(["a"]);
  });
});
