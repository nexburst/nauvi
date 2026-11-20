import { describe, expect, it } from "vitest";
import { MAX_LABEL, middleTruncate, parseCloudName, shortLabels } from "./contextLabel";

const arn = (name: string, region = "eu-west-1", account = "123456789012") =>
  `arn:aws:eks:${region}:${account}:cluster/${name}`;

describe("parseCloudName", () => {
  it("finds the cluster name in an EKS ARN", () => {
    expect(parseCloudName(arn("payments-prod"))).toEqual({
      name: "payments-prod",
      qualifiers: ["eu-west-1", "123456789012"],
    });
    expect(parseCloudName("arn:aws-us-gov:eks:us-gov-west-1:1:cluster/gov")?.name).toBe("gov");
  });

  it("finds it in eksctl, GKE and AKS names", () => {
    expect(parseCloudName("ana@blue.us-east-2.eksctl.io")).toEqual({ name: "blue", qualifiers: ["us-east-2", "ana"] });
    expect(parseCloudName("gke_my-project_europe-west1-b_web-cluster")).toEqual({
      name: "web-cluster",
      qualifiers: ["europe-west1-b", "my-project"],
    });
    expect(
      parseCloudName(
        "/subscriptions/0000/resourceGroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod",
      ),
    ).toEqual({ name: "aks-prod", qualifiers: ["rg-prod", "0000"] });
  });

  it("leaves other names alone", () => {
    expect(parseCloudName("kind-kubeloupe-test")).toBeNull();
    expect(parseCloudName("aks-prod-admin")).toBeNull();
    expect(parseCloudName("arn:aws:iam::1:role/x")).toBeNull();
    expect(parseCloudName("gke_only_two")).toBeNull();
  });
});

describe("middleTruncate", () => {
  it("keeps short names whole", () => {
    expect(middleTruncate("minikube")).toBe("minikube");
    expect(middleTruncate("x".repeat(MAX_LABEL))).toBe("x".repeat(MAX_LABEL));
  });

  it("cuts long names in the middle, keeping more of the end", () => {
    const name = "team-platform-production-eu-west-1-cluster-blue-0123456789ab";
    const out = middleTruncate(name);
    expect([...out]).toHaveLength(MAX_LABEL);
    expect(out).toBe("team-plat…e-0123456789ab");
    expect(out.endsWith("0123456789ab")).toBe(true);
  });
});

describe("shortLabels", () => {
  it("shows the cluster name of cloud contexts, plain names as they are", () => {
    const labels = shortLabels([arn("payments-prod"), "gke_p_z_web", "kind-dev"]);
    expect([...labels.values()]).toEqual(["payments-prod", "web", "kind-dev"]);
  });

  it("tells two clusters of one account apart", () => {
    const labels = shortLabels([arn("payments-prod"), arn("payments-staging")]);
    expect(labels.get(arn("payments-prod"))).toBe("payments-prod");
    expect(labels.get(arn("payments-staging"))).toBe("payments-staging");
  });

  it("qualifies clusters of the same name as far as needed", () => {
    const eu = arn("prod", "eu-west-1");
    const us = arn("prod", "us-east-1");
    expect(shortLabels([eu, us])).toEqual(
      new Map([
        [eu, "prod (eu-west-1)"],
        [us, "prod (us-east-1)"],
      ]),
    );
    const a = arn("prod", "eu-west-1", "111");
    const b = arn("prod", "eu-west-1", "222");
    expect([...shortLabels([a, b]).values()]).toEqual(["prod (eu-west-1, 111)", "prod (eu-west-1, 222)"]);
  });

  it("a plain name keeps its label next to a cloud cluster of that name", () => {
    const labels = shortLabels(["prod", arn("prod")]);
    expect(labels.get("prod")).toBe("prod");
    expect(labels.get(arn("prod"))).toBe("prod (eu-west-1)");
  });

  it("falls back to the full name when nothing else tells them apart", () => {
    const head = "a".repeat(20);
    const tail = "z".repeat(30);
    const one = `${head}-one-${tail}`;
    const two = `${head}-two-${tail}`;
    expect(shortLabels([one, two])).toEqual(
      new Map([
        [one, one],
        [two, two],
      ]),
    );
  });

  it("gives every context a different label", () => {
    const ids = [arn("prod"), arn("prod", "us-east-1"), "prod", "prod (eu-west-1)", "gke_p_eu_prod", "x".repeat(60)];
    const labels = shortLabels(ids);
    expect(labels.size).toBe(ids.length);
    expect(new Set(labels.values()).size).toBe(ids.length);
  });
});
