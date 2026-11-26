import { describe, expect, it } from "vitest";
import { contextText, dockContext, sinceLabel, workloadGroup } from "./dockContext";
import { ALL_CONTAINERS } from "./logs";

const resource = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };
const pod = { resource, namespace: "demo", name: "web-1" };

describe("sinceLabel", () => {
  it("names the picker's options", () => {
    expect(sinceLabel("all")).toBe("all time");
    expect(sinceLabel(undefined)).toBe("all time");
    expect(sinceLabel("300")).toBe("the last 5m");
    expect(sinceLabel("3600")).toBe("the last 1h");
    expect(sinceLabel("45")).toBe("the last 45s");
    expect(sinceLabel("nope")).toBe("all time");
  });
});

describe("dockContext", () => {
  it("pod logs: pod, namespace, container and since, with links", () => {
    const parts = dockContext({ type: "podLogs", pod }, { container: "app", since: "300" });
    expect(contextText(parts)).toBe("Logs of pod web-1 in namespace demo, container app, from the last 5m");
    expect(parts.filter((p) => p.link).map((p) => p.link)).toEqual([
      { group: "", kind: "Pod", namespace: "demo", name: "web-1" },
      { group: "", kind: "Namespace", namespace: "", name: "demo" },
    ]);
  });

  it("pod logs name the run they show (#493)", () => {
    const parts = dockContext({ type: "podLogs", pod }, { container: "app", run: "previous run, exited with code 1, 93s ago" });
    expect(contextText(parts)).toBe(
      "Logs of pod web-1 in namespace demo, container app, previous run, exited with code 1, 93s ago, from all time",
    );
    expect(parts.filter((p) => p.run).map((p) => p.text)).toEqual(["previous run, exited with code 1, 93s ago"]);
  });

  it("pod logs of all containers", () => {
    const parts = dockContext({ type: "podLogs", pod }, { container: ALL_CONTAINERS });
    expect(contextText(parts)).toBe("Logs of pod web-1 in namespace demo, all containers, from all time");
  });

  it("workload logs link the workload in its API group", () => {
    const parts = dockContext({ type: "workloadLogs", workload: { kind: "Deployment", namespace: "demo", name: "web" } }, { container: "" });
    expect(contextText(parts)).toBe("Logs of deployment web in namespace demo, all pods, all containers, from all time");
    expect(parts[1].link).toEqual({ group: "apps", kind: "Deployment", namespace: "demo", name: "web" });
    expect(workloadGroup("Job")).toBe("batch");
  });

  it("a shell names its container, or the default one", () => {
    expect(contextText(dockContext({ type: "terminal", pod }, { shellContainer: "app" }))).toBe(
      "Shell into pod web-1, container app, in namespace demo",
    );
    expect(contextText(dockContext({ type: "terminal", pod, container: null }))).toBe(
      "Shell into pod web-1, default container, in namespace demo",
    );
  });

  it("attach, debug and node shells", () => {
    expect(contextText(dockContext({ type: "attach", pod, container: "app" }))).toBe(
      "Attached to pod web-1, container app, in namespace demo",
    );
    expect(contextText(dockContext({ type: "debug", pod, target: "app", image: "busybox" }))).toBe(
      "Debug container busybox in pod web-1, sharing the processes of app, in namespace demo",
    );
    const node = dockContext({ type: "nodeShell", node: "n1", namespace: "kube-system" });
    expect(contextText(node)).toBe("Root shell on node n1, through a pod in namespace kube-system");
    expect(node[1].link).toEqual({ group: "", kind: "Node", namespace: "", name: "n1" });
  });
});
