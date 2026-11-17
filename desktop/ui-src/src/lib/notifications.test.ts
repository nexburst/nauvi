import { describe, expect, it } from "vitest";
import type { ResourceRef } from "./bindings";
import { addNotification, badgeText, notificationTime, openProblem, targetText } from "./notifications";
import type { NotificationEntry } from "./notifications";

const pods: ResourceRef = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };

function entry(id: number, message: string, extra: Partial<NotificationEntry> = {}) {
  return { id, at: id * 1000, level: "error" as const, message, context: "kind", target: null, ...extra };
}

describe("addNotification", () => {
  it("adds newest first", () => {
    const list = addNotification(addNotification([], entry(1, "a")), entry(2, "b"));
    expect(list.map((e) => e.message)).toEqual(["b", "a"]);
    expect(list[0].count).toBe(1);
  });

  it("folds the same message shown again", () => {
    let list = addNotification([], entry(1, "a"));
    list = addNotification(list, entry(2, "a"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, count: 2, at: 2000 });
  });

  it("keeps a repeat apart when the level, context or object differs", () => {
    let list = addNotification([], entry(1, "a"));
    list = addNotification(list, entry(2, "a", { level: "success" }));
    list = addNotification(list, entry(3, "a", { level: "success", context: "other" }));
    list = addNotification(
      list,
      entry(4, "a", { level: "success", context: "other", target: { resource: pods, namespace: "demo", name: "web" } }),
    );
    expect(list).toHaveLength(4);
  });

  it("drops the oldest past the cap", () => {
    let list: NotificationEntry[] = [];
    for (let i = 0; i < 5; i++) list = addNotification(list, entry(i, `m${i}`), 3);
    expect(list.map((e) => e.message)).toEqual(["m4", "m3", "m2"]);
  });
});

describe("badgeText", () => {
  it("is empty for none and caps at 99+", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(100)).toBe("99+");
  });
});

describe("notificationTime", () => {
  it("shows the time today and the date on another day", () => {
    const at = new Date(2026, 10, 16, 9, 5, 3).getTime();
    expect(notificationTime(at, new Date(2026, 10, 16, 18, 0).getTime())).toBe("09:05:03");
    expect(notificationTime(at, new Date(2026, 10, 17, 1, 0).getTime())).toBe("Nov 16 09:05");
  });
});

describe("targets", () => {
  it("names the object", () => {
    expect(targetText({ resource: pods, namespace: "demo", name: "web" })).toBe("Pod demo/web");
    expect(targetText({ resource: { ...pods, kind: "Node", namespaced: false }, namespace: "", name: "n1" })).toBe(
      "Node n1",
    );
  });

  it("opens only in the context it came from", () => {
    const e = { ...entry(1, "a", { target: { resource: pods, namespace: "demo", name: "web" } }), count: 1 };
    expect(openProblem(e, "kind")).toBe("");
    expect(openProblem(e, "prod")).toContain("switch to it");
  });
});
