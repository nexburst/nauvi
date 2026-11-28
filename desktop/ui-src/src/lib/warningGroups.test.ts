import { describe, expect, it } from "vitest";
import type { EventInfo } from "./bindings";
import { groupWarnings, stripPodIds, timesText, warningReason, warningSubject, warningSummary } from "./warningGroups";

const UID = "3f2a9c1e-0b4d-4e5f-8a6b-7c8d9e0f1a2b";

function ev(over: Partial<EventInfo>): EventInfo {
  return {
    key: "demo/e",
    kind: "Warning",
    reason: "BackOff",
    message: "",
    object: "",
    object_api_version: "v1",
    object_kind: "Pod",
    object_namespace: "demo",
    object_name: "p",
    time: 100,
    count: 1,
    owner_kind: "",
    owner_name: "",
    ...over,
  };
}

describe("groupWarnings", () => {
  it("groups one reason on the pods of one owner, newest group first", () => {
    const groups = groupWarnings([
      ev({ key: "a", object_name: "job-x-1", reason: "FailedScheduling", owner_kind: "Job", owner_name: "job-x", time: 50, count: 3 }),
      ev({ key: "b", object_name: "job-x-2", reason: "FailedScheduling", owner_kind: "Job", owner_name: "job-x", time: 90 }),
      // The same pod twice is one object.
      ev({ key: "c", object_name: "job-x-2", reason: "FailedScheduling", owner_kind: "Job", owner_name: "job-x", time: 80 }),
      // Another reason on the same owner is another group.
      ev({ key: "d", object_name: "job-x-1", reason: "FailedMount", owner_kind: "Job", owner_name: "job-x", time: 200 }),
      // Without an owner: one group per object.
      ev({ key: "e", object_kind: "Deployment", object_name: "api", reason: "FailedCreate", time: 10 }),
      ev({ key: "f", object_kind: "Deployment", object_name: "db", reason: "FailedCreate", time: 20 }),
    ]);
    expect(groups.map((g) => [g.reason, g.objects, g.count, g.time, g.events.length])).toEqual([
      ["FailedMount", 1, 1, 200, 1],
      ["FailedScheduling", 2, 5, 90, 3],
      ["FailedCreate", 1, 1, 20, 1],
      ["FailedCreate", 1, 1, 10, 1],
    ]);
    expect(groups[1].newest.key).toBe("b");
    expect(warningSubject(groups[1])).toBe("2 pods of Job job-x");
    expect(warningSubject(groups[0])).toBe("Pod job-x-1");
    expect(warningSubject(groups[2])).toBe("Deployment db");
  });

  it("is empty for no events", () => {
    expect(groupWarnings([])).toEqual([]);
  });
});

describe("the words of a warning group", () => {
  it("strips the kubelet's name_namespace(uid) from messages", () => {
    expect(stripPodIds(`Back-off restarting failed container app in pod web-5d8f-abc_demo(${UID})`)).toBe(
      "Back-off restarting failed container app in pod web-5d8f-abc",
    );
    expect(stripPodIds("exceeded quota: compute, requested: cpu=1")).toBe("exceeded quota: compute, requested: cpu=1");
  });

  it("names the reason, sums up the message and counts", () => {
    const [g] = groupWarnings([
      ev({ message: `Back-off restarting failed container app in pod web_demo(${UID})`, count: 212 }),
    ]);
    expect(warningReason(g)).toBe("Back-off restarting");
    expect(warningSummary(g)).toBe("Container app keeps failing; restarting it after a delay");
    expect(timesText(g.count)).toBe("212×");
    expect(timesText(1)).toBe("");
    const [plain] = groupWarnings([ev({ reason: "FailedCreate", message: "exceeded quota" })]);
    expect(warningSummary(plain)).toBe("");
  });
});
