import { describe, expect, it } from "vitest";
import type { ContainerDetail, PodExtras, RelatedEvent, StateInfo } from "./bindings";
import { podWhy, pullCause } from "./podWhy";

const NONE: StateInfo = { state: "", reason: "", message: "", exit_code: 0, since: "" };
const running: StateInfo = { ...NONE, state: "running", since: "40s" };
const waiting = (reason: string, message = ""): StateInfo => ({ ...NONE, state: "waiting", reason, message });
const ended = (exit_code: number, reason = "Error", message = ""): StateInfo => ({
  ...NONE,
  state: "terminated",
  reason,
  message,
  exit_code,
  since: "2m",
});

function c(state: StateInfo, last_state: StateInfo = NONE, over: Partial<ContainerDetail> = {}): ContainerDetail {
  return {
    name: "app",
    kind: "regular",
    image: "registry.invalid/inventory-api:1.2.3",
    image_id: "",
    command: [],
    args: [],
    secrets_hidden: false,
    state,
    last_state,
    ready: state.state === "running",
    restarts: last_state.state ? 3 : 0,
    requests: {},
    limits: {},
    ports: [],
    probes: [],
    mounts: [],
    env: [],
    ...over,
  };
}

function pod(containers: ContainerDetail[], over: Partial<PodExtras> = {}): PodExtras {
  return {
    phase: "Running",
    reason: "",
    message: "",
    node: "n",
    pod_ips: [],
    host_ip: "",
    qos_class: "",
    priority_class: "",
    service_account: "",
    containers,
    log_containers: [],
    ...over,
  };
}

const warn = (reason: string, message: string): RelatedEvent => ({ type: "Warning", reason, message, count: 5, age: "20s", time: 0 });
const normal = (reason: string): RelatedEvent => ({ type: "Normal", reason, message: "", count: 1, age: "1m", time: 0 });

const PULL =
  'Back-off pulling image "registry.invalid/inventory-api:1.2.3": ErrImagePull: failed to pull and unpack image ' +
  '"registry.invalid/inventory-api:1.2.3": failed to resolve reference "registry.invalid/inventory-api:1.2.3": ' +
  'failed to do request: Head "https://registry.invalid/v2/inventory-api/manifests/1.2.3": dial tcp: lookup ' +
  "registry.invalid on 10.96.0.10:53: no such host";

describe("pullCause", () => {
  it("names what went wrong in the common pull errors", () => {
    expect(pullCause(PULL)).toBe("host registry.invalid not found");
    expect(pullCause('failed to resolve reference "docker.io/library/nginx:nope": docker.io/library/nginx:nope: not found')).toBe(
      "no such image or tag",
    );
    expect(pullCause("pull access denied, repository does not exist or may require authorization")).toMatch(/pull secret/);
    expect(pullCause("429 Too Many Requests - Server message: toomanyrequests")).toMatch(/rate limit/);
    expect(pullCause("dial tcp 1.2.3.4:443: i/o timeout")).toBe("the registry did not answer");
    expect(pullCause("something else")).toBe("");
  });
});

describe("podWhy", () => {
  it("says nothing for a healthy pod, even with an old warning", () => {
    expect(podWhy(pod([c(running)]), [warn("Unhealthy", "Readiness probe failed: x")])).toBeNull();
    expect(podWhy(pod([c(waiting("ContainerCreating"))], { phase: "Pending" }), [normal("Scheduled")])).toBeNull();
  });

  it("an image that cannot be pulled: the image and the cause, the raw message kept", () => {
    const w = warn("BackOff", 'Back-off pulling image "registry.invalid/inventory-api:1.2.3"');
    const why = podWhy(pod([c(waiting("ImagePullBackOff", PULL))], { phase: "Pending" }), [normal("Scheduled"), w]);
    expect(why).toMatchObject({
      headline: "Image registry.invalid/inventory-api:1.2.3 cannot be pulled: host registry.invalid not found",
      container: "app",
      reason: "ImagePullBackOff",
      detail: PULL,
      previous: false,
      lastRun: "",
      warning: w,
    });
  });

  it("a crash loop: the last run's exit and its termination message, previous logs offered", () => {
    const why = podWhy(pod([c(waiting("CrashLoopBackOff", "back-off 5m0s"), ended(1, "Error", "panic: no DB_URL\n"))]), []);
    expect(why).toMatchObject({
      headline: "Container app keeps crashing",
      reason: "CrashLoopBackOff",
      lastRun: "Last run exited with code 1, 2m ago",
      termination: "panic: no DB_URL",
      previous: true,
    });
  });

  it("out of memory reads as such", () => {
    expect(podWhy(pod([c(waiting("CrashLoopBackOff"), ended(137, "OOMKilled"))]), [])?.headline).toBe(
      "Container app keeps running out of memory",
    );
    expect(podWhy(pod([c(ended(137, "OOMKilled"))], { phase: "Failed" }), [])?.headline).toBe("Container app was killed: out of memory");
  });

  it("init containers first: they hold the others back", () => {
    const init = c(waiting("CrashLoopBackOff"), ended(2), { name: "migrate", kind: "init" });
    const main = c(waiting("PodInitializing"));
    expect(podWhy(pod([init, main], { phase: "Pending" }), [])?.container).toBe("migrate");
  });

  it("a container that cannot start says why", () => {
    const why = podWhy(pod([c(waiting("CreateContainerConfigError", 'secret "db" not found'))]), []);
    expect(why?.headline).toBe('Container app cannot start: secret "db" not found');
    expect(why?.detail).toBe("");
  });

  it("an unschedulable pod: the scheduler's event in words", () => {
    const w = warn("FailedScheduling", "0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available");
    const why = podWhy(pod([c(waiting(""))], { phase: "Pending" }), [w]);
    expect(why?.headline).toBe("No node has enough CPU");
    expect(why?.container).toBe("");
    expect(why?.detail).toBe(w.message);
  });

  it("an evicted pod", () => {
    const why = podWhy(pod([], { phase: "Failed", reason: "Evicted", message: "The node was low on resource: memory." }), []);
    expect(why?.headline).toBe("Evicted: The node was low on resource: memory.");
    expect(why?.detail).toBe("");
  });

  it("what the table flags gets an answer: the newest warning, else the verdict", () => {
    const w = warn("Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503");
    expect(podWhy(pod([c(running, NONE, { ready: false })]), [w], "Not ready")?.headline).toBe("Readiness probe failed");
    expect(podWhy(pod([c(running, NONE, { ready: false })]), [], "Not ready")?.headline).toBe("Not ready");
  });
});
