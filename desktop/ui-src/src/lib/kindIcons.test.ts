import { describe, expect, it } from "vitest";
import { kindIcon, viewIcon } from "./kindIcons";
import { ICONS } from "./icons/icons";

const kind = (k: string, category: "workloads" | "custom" | "network" = "workloads", crd = false) => ({
  id: `x/${k}`,
  category,
  crd,
  resource: { kind: k },
});

describe("kind icons", () => {
  it("a built-in kind has its own icon", () => {
    expect(kindIcon(kind("Pod"))).toBe("pod");
    expect(kindIcon(kind("Deployment"))).toBe("deployment");
    expect(kindIcon(kind("Service", "network"))).toBe("service");
  });

  it("a kind nauvi does not know takes its group's icon, a CRD's kind never a built-in one", () => {
    expect(kindIcon(kind("Rollout"))).toBe("pod");
    expect(kindIcon(kind("Pod", "custom", true))).toBe("shapes");
  });

  it("views have icons too, and a berth of a kind not served here is guessed from its id", () => {
    expect(viewIcon("overview", [])).toBe("dashboard");
    expect(viewIcon("helm", [])).toBe("helm");
    expect(viewIcon("v1/pods", [])).toBe("pod");
    expect(viewIcon("networking.k8s.io/v1/ingresses", [])).toBe("ingress");
    expect(viewIcon("example.com/v1/widgets", [])).toBe("shapes");
  });

  it("every icon it names is in the set", () => {
    for (const k of ["Pod", "CronJob", "Lease", "Secret", "PersistentVolumeClaim", "ClusterRoleBinding", "DeviceClass"])
      expect(ICONS[kindIcon(kind(k))]).toBeDefined();
  });
});
