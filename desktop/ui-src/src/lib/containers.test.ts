import { describe, expect, it } from "vitest";
import type { MountInfo, StateInfo } from "./bindings";
import {
  envSourceText,
  envSummary,
  mountText,
  quantitiesText,
  shellJoin,
  stateSince,
  stateText,
  stateTone,
} from "./containers";

const st = (s: Partial<StateInfo>): StateInfo => ({
  state: "",
  reason: "",
  message: "",
  exit_code: 0,
  since: "",
  ...s,
});

describe("stateTone", () => {
  it("is red for crash loops, pull errors and failed or OOM-killed runs", () => {
    expect(stateTone(st({ state: "waiting", reason: "CrashLoopBackOff" }))).toBe("bad");
    expect(stateTone(st({ state: "waiting", reason: "ImagePullBackOff" }))).toBe("bad");
    expect(stateTone(st({ state: "terminated", reason: "Error", exit_code: 1 }))).toBe("bad");
    expect(stateTone(st({ state: "terminated", reason: "OOMKilled", exit_code: 137 }))).toBe("bad");
  });
  it("is amber while starting, green when running, muted when done", () => {
    expect(stateTone(st({ state: "waiting", reason: "ContainerCreating" }))).toBe("warn");
    expect(stateTone(st({ state: "running" }))).toBe("ok");
    expect(stateTone(st({ state: "terminated", reason: "Completed" }))).toBe("muted");
    expect(stateTone(st({}))).toBe("muted");
  });
});

describe("stateText", () => {
  it("names the state, the reason and the exit code", () => {
    expect(stateText(st({ state: "running" }))).toBe("Running");
    expect(stateText(st({ state: "waiting", reason: "CrashLoopBackOff" }))).toBe("Waiting: CrashLoopBackOff");
    expect(stateText(st({ state: "terminated", reason: "OOMKilled", exit_code: 137 }))).toBe(
      "Terminated: OOMKilled (exit 137)",
    );
    expect(stateText(st({}))).toBe("No status yet");
  });
  it("says when", () => {
    expect(stateSince(st({ state: "running", since: "5m" }))).toBe("started 5m ago");
    expect(stateSince(st({ state: "terminated", since: "2h" }))).toBe("2h ago");
    expect(stateSince(st({ state: "waiting" }))).toBe("");
  });
});

describe("quantitiesText", () => {
  it("lists each resource, or a dash", () => {
    expect(quantitiesText({ memory: "64Mi", cpu: "100m" })).toBe("cpu 100m · memory 64Mi");
    expect(quantitiesText({})).toBe("—");
  });
});

describe("envSourceText", () => {
  it("shows references, never values", () => {
    expect(envSourceText("secret:db/password")).toBe("from Secret db/password");
    expect(envSourceText("configmap:cfg/mode")).toBe("from ConfigMap cfg/mode");
    expect(envSourceText("field:metadata.name")).toBe("from field metadata.name");
    expect(envSourceText("")).toBe("value set");
  });
});

describe("envSummary", () => {
  const e = (name: string, source = "") => ({ name, source });
  it("counts variables and names whole sources", () => {
    expect(envSummary([e("A"), e("B", "secret:db/password")])).toBe("2 variables (1 from a Secret)");
    expect(envSummary([e("A", "secret:x/a"), e("B", "secret:x/b"), e("*", "configmap:cfg")])).toBe(
      "2 variables (2 from Secrets) · all of ConfigMap cfg",
    );
    expect(envSummary([e("CFG_*", "secret:all")])).toBe("all of Secret all");
    expect(envSummary([e("ONE")])).toBe("1 variable");
  });
});

describe("mountText", () => {
  const m = (more: Partial<MountInfo>): MountInfo => ({
    name: "kube-api-access-x7k2p",
    path: "/var/run/secrets/kubernetes.io/serviceaccount",
    sub_path: "",
    read_only: true,
    source: "projected (service account token)",
    ...more,
  });
  it("names the source, the sub-path and read-only", () => {
    expect(mountText(m({}))).toBe(
      "/var/run/secrets/kubernetes.io/serviceaccount ← projected (service account token) (ro)",
    );
    expect(mountText(m({ path: "/data", source: "pvc data", sub_path: "x", read_only: false }))).toBe(
      "/data ← pvc data (subPath x)",
    );
    // A volume the pod does not declare: its name.
    expect(mountText(m({ path: "/x", source: "", read_only: false }))).toBe("/x ← kube-api-access-x7k2p");
  });
});

describe("shellJoin", () => {
  it("quotes only what needs it", () => {
    expect(shellJoin(["sh", "-c", 'echo "hi"; sleep 1'])).toBe(`sh -c 'echo "hi"; sleep 1'`);
    expect(shellJoin(["--token=••••", "--port=8080", ""])).toBe("--token=•••• --port=8080 ''");
    expect(shellJoin(["it's"])).toBe(`'it'\\''s'`);
  });
});
