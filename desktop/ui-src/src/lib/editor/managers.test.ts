import { describe, expect, it } from "vitest";
import { managerLabel, toolList } from "./managers";

describe("managerLabel", () => {
  it("names known tools in words", () => {
    expect(managerLabel("kubectl-client-side-apply")).toBe("kubectl apply");
    expect(managerLabel("helm")).toBe("Helm");
    expect(managerLabel("kube-controller-manager")).toBe("a Kubernetes controller");
  });

  it("reads kubectl's verbs", () => {
    expect(managerLabel("kubectl-create")).toBe("kubectl create");
    expect(managerLabel("kubectl-rollout")).toBe("kubectl rollout");
    expect(managerLabel("kubectl-set-image")).toBe("kubectl set image");
  });

  it("keeps unknown managers as they are", () => {
    expect(managerLabel("my-operator")).toBe("my-operator");
  });
});

describe("toolList", () => {
  it("joins the tools, once each", () => {
    expect(toolList([])).toBe("");
    expect(toolList(["helm"])).toBe("Helm");
    expect(toolList(["kubectl-client-side-apply", "helm"])).toBe("kubectl apply and Helm");
    expect(toolList(["kubectl-edit", "helm", "kubectl-edit", "x"])).toBe("kubectl edit, Helm and x");
  });
});
