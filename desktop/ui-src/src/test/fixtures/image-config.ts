// Misconfigurations (#538): what the Trivy Operator's ConfigAuditReports
// say about the fake cluster's workloads, as `cmd_image_config_summary`
// lists them, and one full report (deploy/web).

import type {
  ConfigCheck,
  ConfigDetail,
  SeverityCounts,
  VulnsState,
  WorkloadConfig,
} from "../../lib/bindings";

/** What the fake answers (`FakeCluster.imageConfig`). */
export interface FakeImageConfig {
  /** `ok`, or the state every listing has. */
  state: VulnsState;
  workloads: WorkloadConfig[];
  /** Full reports by `kind/namespace/name`. */
  details: Record<string, ConfigDetail>;
  /** Namespaces where the reports may not be listed. */
  forbidden: string[];
  notes: string[];
}

const zero: SeverityCounts = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
};
const counts = (c: Partial<SeverityCounts>): SeverityCounts => ({
  ...zero,
  ...c,
});
const now = () => Math.floor(Date.now() / 1000);

function row(
  kind: string,
  namespace: string,
  name: string,
  failed: Partial<SeverityCounts>,
  p: Partial<WorkloadConfig> = {},
): WorkloadConfig {
  return {
    target: { kind, namespace, name },
    failed: counts(failed),
    report_namespace: namespace,
    report_name: `${kind.toLowerCase()}-${name}`,
    reports: 1,
    scanner: "Trivy 0.69.3",
    scanned_at: now() - 86400,
    ...p,
  };
}

const check = (
  id: string,
  severity: ConfigCheck["severity"],
  title: string,
  remediation: string,
  container = "nginx",
): ConfigCheck => ({
  id,
  title,
  severity,
  category: "Kubernetes Security Check",
  description: `${title}: the operator's description.`,
  remediation,
  messages: [`Container '${container}' of Deployment 'web' should change this`],
  container,
});

export function imageConfigFixture(): FakeImageConfig {
  const web = row(
    "Deployment",
    "demo",
    "web",
    { critical: 1, high: 2, medium: 1, low: 2 },
    { report_name: "replicaset-web-5f6b7c", reports: 2 },
  );
  const detail: ConfigDetail = {
    workload: web,
    passed: 18,
    failed: [
      check(
        "KSV017",
        "critical",
        "Privileged container",
        "Change 'containers[].securityContext.privileged' to 'false'.",
      ),
      check(
        "KSV014",
        "high",
        "Root file system is not read-only",
        "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'.",
      ),
      check(
        "KSV118",
        "high",
        "Default security context configured",
        "Set a security context for the pod and its containers.",
      ),
      check(
        "KSV001",
        "medium",
        "Can elevate its own privileges",
        "Set 'containers[].securityContext.allowPrivilegeEscalation' to 'false'.",
      ),
      check(
        "KSV011",
        "low",
        "CPU not limited",
        "Set a limit value under 'containers[].resources.limits.cpu'.",
      ),
      check(
        "KSV016",
        "low",
        "Memory requests not specified",
        "Set 'containers[].resources.requests.memory'.",
      ),
    ],
  };
  return {
    state: "ok",
    workloads: [
      web,
      row("StatefulSet", "demo", "cache", { high: 1, low: 3 }),
      row("Deployment", "demo", "logger", { medium: 2, low: 4 }),
      row("Service", "demo", "web", {}),
      row(
        "Deployment",
        "team-a",
        "app",
        { low: 1 },
        { scanned_at: now() - 10 * 86400 },
      ),
    ],
    details: { "Deployment/demo/web": detail },
    forbidden: [],
    notes: [],
  };
}
