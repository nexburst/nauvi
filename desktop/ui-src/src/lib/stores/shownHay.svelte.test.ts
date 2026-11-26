import { describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import type { ResourceKind } from "../bindings";
import { columnsFor, EMPTY_METRICS, shownColumns } from "../columns";
import type { Metrics } from "../columns";
import { shownHay } from "./tableFilter.svelte";

const KIND: ResourceKind = {
  resource: { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true },
  id: "v1/pods",
  label: "Pods",
  category: "workloads",
  crd: false,
  verbs: [],
  short_names: [],
  columns: [
    { key: "name", label: "Name", kind: "text", default_hidden: false },
    { key: "namespace", label: "Namespace", kind: "text", default_hidden: false },
    { key: "status", label: "Status", kind: "status", default_hidden: false },
    { key: "cpu", label: "CPU", kind: "podCpu", default_hidden: false },
    { key: "qos", label: "QoS", kind: "text", default_hidden: true },
  ],
  actions: [],
};
const ROW = { name: "web-1", namespace: "demo", cells: ["web-1", "demo", "Running", "", "Burstable"] };

describe("shownHay (#512)", () => {
  it("changes when the shown columns do, not on a metrics refresh", () => {
    let metrics = $state.raw<Metrics>(EMPTY_METRICS);
    let extra = $state.raw<string[]>([]);
    let changes = 0;
    let text = "";
    const cleanup = $effect.root(() => {
      // As in ResourceTable: the columns are rebuilt whenever the metrics change.
      const columns = $derived(shownColumns(columnsFor(KIND), [], metrics, extra));
      const hay = shownHay(
        () => KIND.columns,
        () => columns,
      );
      // What the ListFilter's regex run depends on.
      $effect(() => {
        text = hay.current.raw(ROW);
        changes++;
      });
    });
    flushSync();
    expect(changes).toBe(1);
    expect(text).toBe("web-1\ndemo\nweb-1\ndemo\nRunning");

    // Metrics refreshes: new column objects, the same shown columns.
    for (let i = 1; i <= 3; i++) {
      metrics = { ...EMPTY_METRICS, since: i };
      flushSync();
    }
    expect(changes).toBe(1);

    // QoS turned on: the text changes, once.
    extra = ["qos"];
    flushSync();
    expect(changes).toBe(2);
    expect(text).toContain("Burstable");
    cleanup();
  });
});
