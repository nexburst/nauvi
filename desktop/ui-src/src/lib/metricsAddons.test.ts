import { describe, expect, it } from "vitest";
import type { MetricsAddonRequest } from "./bindings";
import { diskPercent, diskText, looksLocal, sameAddonRequest } from "./metricsAddons";

const req: MetricsAddonRequest = {
  addon: "metrics-server",
  name: "metrics-server",
  namespace: "kube-system",
  values: "replicas: 1\n",
  options: ["kubelet-insecure-tls"],
  create_namespace: true,
  dry_run: true,
  reveal: false,
};

describe("metrics add-ons", () => {
  it("recognises local clusters by their context name", () => {
    expect(looksLocal("kind-kubeloupe-test")).toBe(true);
    expect(looksLocal("k3d-dev")).toBe(true);
    expect(looksLocal("minikube")).toBe(true);
    expect(looksLocal("prod-eu")).toBe(false);
    expect(looksLocal("mykind-cluster")).toBe(false);
  });

  it("a dry run may be confirmed only for the same request", () => {
    expect(sameAddonRequest(req, { ...req, dry_run: false })).toBe(true);
    expect(sameAddonRequest(req, { ...req, values: "replicas: 2\n" })).toBe(false);
    expect(sameAddonRequest(req, { ...req, options: [] })).toBe(false);
    expect(sameAddonRequest(req, { ...req, namespace: "metrics" })).toBe(false);
    expect(sameAddonRequest(req, { ...req, addon: "prometheus" })).toBe(false);
    expect(sameAddonRequest(null, req)).toBe(false);
  });

  it("formats a node's disk use", () => {
    const d = { name: "n", mountpoint: "/", used_bytes: 12.5 * 1024 ** 3, size_bytes: 50 * 1024 ** 3 };
    expect(diskText(d)).toBe("12.5Gi / 50Gi (25%)");
    expect(diskPercent({ ...d, size_bytes: 0 })).toBe(0);
  });
});
