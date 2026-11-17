// Kinds a sidebar group always lists (#332): when the cluster does not serve
// one (an older Kubernetes, a feature gate off), the sidebar still shows it,
// greyed out, so the group reads the same on every cluster.

import type { Category, ResourceKind } from "./bindings";

export interface ExpectedKind {
  group: string;
  kind: string;
  label: string;
}

const AR = "admissionregistration.k8s.io";
const DRA = "resource.k8s.io";

export const EXPECTED_KINDS: Partial<Record<Category, ExpectedKind[]>> = {
  config: [
    {
      group: AR,
      kind: "ValidatingAdmissionPolicy",
      label: "Validating Admission Policies",
    },
    {
      group: AR,
      kind: "ValidatingAdmissionPolicyBinding",
      label: "Validating Admission Policy Bindings",
    },
  ],
  devices: [
    { group: DRA, kind: "DeviceClass", label: "Device Classes" },
    { group: DRA, kind: "ResourceClaim", label: "Resource Claims" },
    {
      group: DRA,
      kind: "ResourceClaimTemplate",
      label: "Resource Claim Templates",
    },
    { group: DRA, kind: "ResourceSlice", label: "Resource Slices" },
  ],
};

/** The expected kinds of `category` that `served` (every discovered kind) lacks. */
export function missingKinds(
  category: Category,
  served: ResourceKind[],
): ExpectedKind[] {
  return (EXPECTED_KINDS[category] ?? []).filter(
    (e) =>
      !served.some(
        (k) => k.resource.group === e.group && k.resource.kind === e.kind,
      ),
  );
}

/** The tooltip of a kind the cluster does not serve. */
export function absentTitle(e: ExpectedKind): string {
  return `${e.label}: this cluster does not serve ${e.kind} (${e.group})`;
}
