import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { EMPTY_METRICS } from "../columns";
import type { Column, Row } from "../columns";
import type { Entry } from "./keyed.svelte";
import { visibleRows } from "./visibleRows.svelte";

const entry = (key: string, created: number): Entry<Row> => ({
  key,
  hay: key,
  row: { key, name: key, namespace: "", created, cells: [], status: "", problem: "" } as unknown as Row,
});

describe("visibleRows", () => {
  it("does not filter and sort again when only the clock ticks", () => {
    const sortAge = vi.fn((r: Row) => r.created);
    const age: Column = { key: "age", label: "Age", width: "64px", text: () => "", sort: sortAge };
    let entries = $state.raw([entry("a", 2), entry("b", 1)]);
    let now = $state.raw(1000);
    let shown: string[] = [];
    const cleanup = $effect.root(() => {
      const rows = visibleRows(
        () => ({
          entries,
          match: null,
          sort: { key: "age", dir: "asc" },
          columns: [age],
          metrics: EMPTY_METRICS,
          status: "",
        }),
        () => now,
      );
      $effect(() => {
        shown = rows.value.map((e) => e.key);
      });
    });
    flushSync();
    expect(shown).toEqual(["b", "a"]);
    const runs = sortAge.mock.calls.length;

    // Ticks: no new filter or sort.
    now = 2000;
    flushSync();
    now = 3000;
    flushSync();
    expect(sortAge.mock.calls.length).toBe(runs);

    // New rows: it runs again.
    entries = [entry("a", 2), entry("b", 1), entry("c", 0)];
    flushSync();
    expect(sortAge.mock.calls.length).toBeGreaterThan(runs);
    expect(shown).toEqual(["c", "b", "a"]);
    cleanup();
  });
});
