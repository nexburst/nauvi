import { describe, expect, it } from "vitest";
import { clusterError, isNotFound, NO_KUBECONFIG_HINT } from "./clusterError";

describe("clusterError", () => {
  it("says there is no kubeconfig, not that the cluster is unreachable", () => {
    const e = "No kubeconfig found (looked at /home/me/.kube/config; KUBECONFIG is not set).";
    expect(clusterError(e)).toEqual({ status: "No kubeconfig", message: `${e} ${NO_KUBECONFIG_HINT}` });
  });

  it("keeps the readable connect messages as they are", () => {
    expect(clusterError("Login to `x` failed: nope").status).toBe("Login failed");
    expect(clusterError("Certificate problem connecting").status).toBe("Certificate problem");
    expect(clusterError("Cannot reach the cluster for `x`")).toEqual({
      status: "Cluster unreachable",
      message: "Cannot reach the cluster for `x`",
    });
  });

  it("prefixes anything else", () => {
    expect(clusterError("connection refused").message).toBe("Could not reach the cluster: connection refused");
  });
});

describe("isNotFound", () => {
  it("recognises the API server's not found for that object only", () => {
    expect(isNotFound('pods "web-1" not found', "web-1")).toBe(true);
    expect(isNotFound('describe pod/web-1: pods "web-1" not found', "web-1")).toBe(true);
    expect(isNotFound('pods "web-2" not found', "web-1")).toBe(false);
    expect(isNotFound("pods is forbidden: User cannot get pods", "web-1")).toBe(false);
  });
});
