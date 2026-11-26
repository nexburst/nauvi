import { describe, expect, it } from "vitest";
import { eventHeadline, eventSummary, reasonWords } from "./eventText";

describe("reasonWords", () => {
  it("splits CamelCase reasons into words", () => {
    expect(reasonWords("FailedScheduling")).toBe("Failed scheduling");
    expect(reasonWords("NodeNotReady")).toBe("Node not ready");
    expect(reasonWords("ScalingReplicaSet")).toBe("Scaling replica set");
    expect(reasonWords("Pulled")).toBe("Pulled");
  });
  it("keeps acronyms and uses better words where the name is terse", () => {
    expect(reasonWords("FailedPVCBinding")).toBe("Failed PVC binding");
    expect(reasonWords("BackOff")).toBe("Back-off restarting");
    expect(reasonWords("BackOff", 'Back-off pulling image "nginx:nope"')).toBe("Back-off pulling image");
    expect(reasonWords("Unhealthy")).toBe("Probe failed");
  });
  it("leaves what is not a CamelCase name alone", () => {
    expect(reasonWords("")).toBe("");
    expect(reasonWords("exceeded quota")).toBe("exceeded quota");
    expect(reasonWords("Failed\u{FEFF}Scheduling")).toBe("Failed\u{FEFF}Scheduling");
  });
});

describe("eventSummary", () => {
  it("says which resources no node has enough of", () => {
    expect(
      eventSummary(
        "FailedScheduling",
        "0/3 nodes are available: 3 Insufficient cpu, 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.",
      ),
    ).toBe("No node has enough CPU and memory");
    expect(eventSummary("FailedScheduling", "0/1 nodes are available: 1 Insufficient memory.")).toBe(
      "No node has enough memory",
    );
  });
  it("lists the reasons when nodes are ruled out for different ones", () => {
    expect(
      eventSummary(
        "FailedScheduling",
        "0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.",
      ),
    ).toBe("No node fits: 2 nodes short of CPU, 1 node with taints the pod does not tolerate");
    expect(
      eventSummary("FailedScheduling", "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector."),
    ).toBe("No node fits: no match for the pod's node selector or affinity");
    expect(eventSummary("FailedScheduling", "0/1 nodes are available: 1 node(s) were unschedulable.")).toBe(
      "Every node is cordoned",
    );
  });
  it("names unbound volume claims and empty clusters", () => {
    expect(
      eventSummary(
        "FailedScheduling",
        "0/1 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/1 nodes are available: 1 Preemption is not helpful for scheduling.",
      ),
    ).toBe("A volume claim of the pod is not bound yet");
    expect(eventSummary("FailedScheduling", "no nodes available to schedule pods")).toBe(
      "The cluster has no nodes to run the pod on",
    );
  });
  it("drops the pod UID from back-off messages", () => {
    expect(
      eventSummary(
        "BackOff",
        "Back-off restarting failed container app in pod crashed-7d9f_demo(0b6a3c51-5d1e-4c1f-9a43-1f1b2c3d4e5f)",
      ),
    ).toBe("Container app keeps failing; restarting it after a delay");
    expect(eventSummary("BackOff", 'Back-off pulling image "nginx:nope"')).toBe(
      "Cannot pull image nginx:nope; retrying after a delay",
    );
  });
  it("shortens probe, pull and mount failures", () => {
    expect(eventSummary("Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503")).toBe(
      "Readiness probe failed",
    );
    expect(eventSummary("Failed", 'Failed to pull image "x:1": rpc error: code = NotFound')).toBe(
      "Cannot pull image x:1",
    );
    expect(
      eventSummary("FailedMount", 'MountVolume.SetUp failed for volume "config" : configmap "web-config" not found'),
    ).toBe('Cannot mount volume config: configmap "web-config" not found');
  });
  it("is empty when the message says it well enough", () => {
    expect(eventSummary("Pulled", 'Container image "nginx:1.27" already present on machine')).toBe("");
    expect(eventSummary("FailedScheduling", "something new")).toBe("");
  });
});

describe("eventHeadline", () => {
  it("is the summary, else the message", () => {
    expect(eventHeadline("FailedScheduling", "0/1 nodes are available: 1 Insufficient cpu.")).toBe("No node has enough CPU");
    expect(eventHeadline("Pulled", "already present")).toBe("already present");
  });
});
