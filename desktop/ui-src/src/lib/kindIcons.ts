// The icon of each kind and view in the sidebar, the berths and the cluster
// tree (#481). Built-in kinds by their Kind; anything else by its sidebar
// group, so a kind nauvi does not know still gets a fitting icon.

import { APPLICATIONS_VIEW } from "./applications";
import type { Category, ResourceKind } from "./bindings";
import { CATALOG_VIEW } from "./catalog";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";
import type { IconName } from "./icons/icons";
import { WORKLOADS_VIEW } from "./workloads";

const BY_KIND: Record<string, IconName> = {
  Pod: "pod",
  Deployment: "deployment",
  StatefulSet: "database",
  DaemonSet: "daemon",
  ReplicaSet: "replicas",
  ReplicationController: "replicas",
  Job: "job",
  CronJob: "calendar",
  Service: "service",
  Ingress: "ingress",
  IngressClass: "tag",
  Endpoints: "target",
  EndpointSlice: "target",
  NetworkPolicy: "shield",
  ConfigMap: "file",
  Secret: "secret",
  HorizontalPodAutoscaler: "scale",
  ResourceQuota: "pie",
  LimitRange: "sliders",
  PodDisruptionBudget: "shieldCheck",
  PriorityClass: "flag",
  RuntimeClass: "cpu",
  Lease: "hourglass",
  MutatingWebhookConfiguration: "plug",
  ValidatingWebhookConfiguration: "plug",
  ValidatingAdmissionPolicy: "shield",
  ValidatingAdmissionPolicyBinding: "link",
  MutatingAdmissionPolicy: "shield",
  MutatingAdmissionPolicyBinding: "link",
  PersistentVolumeClaim: "volumeClaim",
  PersistentVolume: "volume",
  StorageClass: "tag",
  Node: "node",
  Namespace: "namespace",
  Event: "activity",
  ServiceAccount: "user",
  Role: "role",
  ClusterRole: "role",
  RoleBinding: "link",
  ClusterRoleBinding: "link",
  DeviceClass: "tag",
  ResourceClaim: "cpu",
  ResourceClaimTemplate: "cpu",
  ResourceSlice: "cpu",
  DeviceTaintRule: "cpu",
  CustomResourceDefinition: "braces",
};

const BY_CATEGORY: Record<Category, IconName> = {
  workloads: "pod",
  network: "service",
  config: "file",
  storage: "volume",
  cluster: "node",
  access: "user",
  devices: "cpu",
  custom: "shapes",
  other: "shapes",
};

/** Views of their own (not kinds). */
const VIEWS: Record<string, IconName> = {
  overview: "dashboard",
  [WORKLOADS_VIEW]: "bars",
  [APPLICATIONS_VIEW]: "apps",
  [HELM_VIEW]: "helm",
  [HELM_CHARTS_VIEW]: "package",
  [PORT_FORWARDS_VIEW]: "forward",
  [CATALOG_VIEW]: "grid",
};

type KindLike = Pick<ResourceKind, "id" | "category" | "crd"> & { resource: { kind: string } };

/** The icon of a kind: its own for a built-in one, else its group's. */
export function kindIcon(kind: KindLike): IconName {
  return (!kind.crd && BY_KIND[kind.resource.kind]) || BY_CATEGORY[kind.category] || "shapes";
}

/** The icon of a view (the Overview, Helm, a kind...) by its id. */
export function viewIcon(view: string, kinds: readonly KindLike[]): IconName {
  const own = VIEWS[view];
  if (own) return own;
  const k = kinds.find((x) => x.id === view);
  if (k) return kindIcon(k);
  // Not served here (a berth from another cluster): guess from the id.
  const plural = view.split("/").pop() ?? "";
  const match = Object.keys(BY_KIND).find((kind) => `${kind.toLowerCase()}s` === plural || `${kind.toLowerCase()}es` === plural);
  return match ? BY_KIND[match] : "shapes";
}
