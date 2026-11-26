import { describe, expect, it } from "vitest";
import { CATALOG_VIEW } from "./catalog";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";
import { healthError, isProbeFailure, isReachabilityError, isWatchless, troubleTitle, visibleDot } from "./health";

describe("isProbeFailure", () => {
  it("is the probe's no-answer, not a login or certificate failure", () => {
    expect(isProbeFailure("Lost the connection to the cluster (https://x); retrying.")).toBe(true);
    expect(isProbeFailure("Login to `x` failed: the plugin exited with 1")).toBe(false);
    expect(isProbeFailure("Certificate problem: unknown issuer")).toBe(false);
  });
});

describe("isReachabilityError", () => {
  it("is a banner that only says the cluster did not answer", () => {
    expect(isReachabilityError("Cannot reach the cluster for `kind-dev` (https://x): refused")).toBe(true);
    expect(isReachabilityError("Could not reach the cluster: timeout")).toBe(true);
    expect(isReachabilityError("Lost the connection to the cluster (https://x). Stopped retrying.")).toBe(true);
    expect(isReachabilityError("The API server is not answering (no reply within 5 s); retrying.")).toBe(true);
  });

  it("is not another error", () => {
    expect(isReachabilityError("")).toBe(false);
    expect(isReachabilityError("Login to `x` failed: expired")).toBe(false);
    expect(isReachabilityError("Could not discover the cluster's resource types: x")).toBe(false);
  });
});

describe("isWatchless", () => {
  it("is the views that start no watch", () => {
    for (const v of [PORT_FORWARDS_VIEW, HELM_VIEW, HELM_CHARTS_VIEW, CATALOG_VIEW]) expect(isWatchless(v)).toBe(true);
    for (const v of ["overview", "v1/pods", "workloads"]) expect(isWatchless(v)).toBe(false);
  });
});

describe("healthError", () => {
  it("shows the probe's text as it is, as Cluster unreachable", () => {
    const message = "Lost the connection to the cluster (https://127.0.0.1:1); retrying.";
    expect(healthError(message)).toEqual({ status: "Cluster unreachable", message });
    const silent = "The API server is not answering (no reply within 5 s); retrying.";
    expect(healthError(silent)).toEqual({ status: "Cluster unreachable", message: silent });
  });

  it("says a failed login or certificate like a failed view", () => {
    expect(healthError("Login to `x` failed: expired").status).toBe("Login failed");
    expect(healthError("Certificate problem: bad").status).toBe("Certificate problem");
  });
});

describe("visibleDot", () => {
  it("follows the header status", () => {
    expect(visibleDot({ ok: null, text: "Connecting…" })).toBe("connecting");
    expect(visibleDot({ ok: true, text: "Live" })).toBe("connected");
    expect(visibleDot({ ok: false, text: "Cluster unreachable" })).toBe("failed");
    expect(visibleDot({ ok: false, text: "Reconnecting…" })).toBe("failed");
  });

  it("stays connected when the cluster only refused", () => {
    expect(visibleDot({ ok: false, text: "Not allowed" })).toBe("connected");
    expect(visibleDot({ ok: false, text: "Not allowed in a, b" })).toBe("connected");
  });
});

describe("troubleTitle", () => {
  it("is the header's text while the cluster does not answer", () => {
    expect(troubleTitle({ ok: false, text: "Cluster unreachable" })).toBe("Cluster unreachable");
    expect(troubleTitle({ ok: false, text: "Reconnecting…" })).toBe("Reconnecting…");
  });

  it("is null when it answers, connects or only refused", () => {
    expect(troubleTitle({ ok: true, text: "Live" })).toBeNull();
    expect(troubleTitle({ ok: null, text: "Connecting…" })).toBeNull();
    expect(troubleTitle({ ok: false, text: "Not allowed" })).toBeNull();
  });
});
