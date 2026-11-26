import { describe, expect, it } from "vitest";
import type { ContainerDetail, StateInfo } from "./bindings";
import { endedText, previousOffer, runLabel } from "./logRun";

const NONE: StateInfo = { state: "", reason: "", message: "", exit_code: 0, since: "" };
const running = (since = "40s"): StateInfo => ({ ...NONE, state: "running", since });
const crashed = (code = 1, since = "93s", reason = "Error"): StateInfo => ({
  ...NONE,
  state: "terminated",
  reason,
  exit_code: code,
  since,
});
const waiting = (reason = "CrashLoopBackOff"): StateInfo => ({ ...NONE, state: "waiting", reason });

function c(state: StateInfo, last_state: StateInfo = NONE, restarts = 0): ContainerDetail {
  return {
    name: "worker",
    kind: "regular",
    image: "busybox",
    image_id: "",
    command: [],
    args: [],
    secrets_hidden: false,
    state,
    last_state,
    ready: state.state === "running",
    restarts,
    requests: {},
    limits: {},
    ports: [],
    probes: [],
    mounts: [],
    env: [],
  };
}

describe("endedText", () => {
  it("says the code and how long ago, and a reason only when it adds something", () => {
    expect(endedText(crashed(1, "93s"))).toBe("exited with code 1, 93s ago");
    expect(endedText(crashed(137, "3m", "OOMKilled"))).toBe("exited with code 137 (OOMKilled), 3m ago");
    expect(endedText(crashed(0, "", "Completed"))).toBe("exited with code 0");
  });
});

describe("runLabel", () => {
  it("names the previous run and its exit code", () => {
    expect(runLabel(c(waiting(), crashed(1, "93s"), 2), true)).toBe("previous run, exited with code 1, 93s ago");
    expect(runLabel(c(running(), NONE), true)).toBe("previous run (it has not restarted)");
    expect(runLabel(undefined, true)).toBe("previous run");
  });

  it("while it waits to restart, the current log is the run that crashed", () => {
    expect(runLabel(c(waiting(), crashed(1, "10s"), 3), false)).toBe(
      "last run, exited with code 1, 10s ago; waiting to restart: CrashLoopBackOff",
    );
    expect(runLabel(c(waiting("ContainerCreating")), false)).toBe("waiting to start: ContainerCreating");
  });

  it("a finished container, and a running one after restarts", () => {
    expect(runLabel(c(crashed(0, "1m", "Completed")), false)).toBe("last run, exited with code 0, 1m ago");
    expect(runLabel(c(running("51s"), crashed(), 1), false)).toBe("current run, started 51s ago after 1 restart");
    expect(runLabel(c(running("51s"), crashed(), 2), false)).toBe("current run, started 51s ago after 2 restarts");
  });

  it("says nothing for a container that never restarted", () => {
    expect(runLabel(c(running()), false)).toBe("");
    expect(runLabel(undefined, false)).toBe("");
  });
});

describe("previousOffer", () => {
  it("offers the run that crashed while the new one has no lines", () => {
    expect(previousOffer(c(running(), crashed(1), 2), false, 0)).toEqual({ crashed: true });
    expect(previousOffer(c(running(), crashed(0, "1m", "Completed"), 1), false, 0)).toEqual({ crashed: false });
  });

  it("not once there are lines, with Previous on, or without an earlier run", () => {
    expect(previousOffer(c(running(), crashed(1), 2), false, 3)).toBeNull();
    expect(previousOffer(c(running(), crashed(1), 2), true, 0)).toBeNull();
    expect(previousOffer(c(running()), false, 0)).toBeNull();
    // Waiting: the current log already is the run that crashed.
    expect(previousOffer(c(waiting(), crashed(1), 2), false, 0)).toBeNull();
    expect(previousOffer(undefined, false, 0)).toBeNull();
  });
});
