// Image security (#534): what the Trivy Operator's reports say about the
// fake cluster's images, as `cmd_image_security_summary` lists them, and
// one full report (nginx).

import type {
  IgnoreRule,
  ImageDetail,
  ImageVulns,
  SeverityCounts,
  Vulnerability,
  VulnsState,
  Workload,
} from "../../lib/bindings";

/** What the fake image security answers (`FakeCluster.imageSecurity`). */
export interface FakeImageSecurity {
  /** `ok`, or the state every listing has (`no_operator`, `no_reports`, `forbidden`). */
  state: VulnsState;
  images: ImageVulns[];
  /** Full reports by `image@digest`. */
  details: Record<string, ImageDetail>;
  /** Namespaces where the reports may not be listed. */
  forbidden: string[];
  /** Notes every listing carries. */
  notes: string[];
  /** The reports may be listed across all namespaces (default: yes). */
  allNamespaces?: boolean;
  /** #537 (`fake/image-triage.ts`): the ignore file's ignores, or why it cannot be read. */
  fileRules?: IgnoreRule[];
  fileError?: string;
  /** A KEV catalogue is kept, with these ids; a download fails with `kevFail`. */
  kevKept?: boolean;
  kevIds?: string[];
  kevFetchedAt?: number;
  kevFail?: string;
}

const zero: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const counts = (c: Partial<SeverityCounts>): SeverityCounts => ({ ...zero, ...c });
const now = () => Math.floor(Date.now() / 1000);
const w = (kind: string, namespace: string, name: string, container = "main"): Workload => ({
  kind,
  namespace,
  name,
  container,
});

function image(p: Partial<ImageVulns> & Pick<ImageVulns, "image">): ImageVulns {
  return {
    source: "trivy_operator",
    digest: "",
    running: true,
    scanned: true,
    counts: zero,
    fixable: zero,
    ignored: zero,
    kev: 0,
    workloads: [],
    report_namespace: "",
    report_name: "",
    reports: 1,
    scanner: "Trivy 0.69.3",
    scanned_at: now() - 2 * 86400,
    ...p,
  };
}

const v = (id: string, pkg: string, installed: string, severity: Vulnerability["severity"], fixed: string): Vulnerability => ({
  id,
  package: pkg,
  installed_version: installed,
  fixed_version: fixed,
  severity,
  score: 0,
  title: `${pkg} issue`,
  link: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  exploit: { kev: false, epss: null, epss_percentile: null, risk: null },
});

export function imageSecurityFixture(): FakeImageSecurity {
  const nginx = image({
    image: "nginx:1.27",
    digest: "sha256:1111111111111111",
    counts: counts({ critical: 2, high: 5, medium: 3 }),
    fixable: counts({ critical: 2, high: 4, medium: 1 }),
    workloads: [w("Deployment", "demo", "web", "nginx")],
    report_namespace: "demo",
    report_name: "replicaset-web-5f6b7c-nginx",
  });
  const vulns = [
    v("CVE-2026-1001", "openssl", "3.0.11-1", "critical", "3.0.15-1"),
    v("CVE-2026-1002", "openssl", "3.0.11-1", "critical", "3.0.14-1"),
    v("CVE-2026-1003", "openssl", "3.0.11-1", "high", "3.0.15-1"),
    v("CVE-2026-1004", "openssl", "3.0.11-1", "high", "3.0.15-1"),
    v("CVE-2026-1005", "curl", "7.88.1-10", "high", "7.88.1-10+deb12u8"),
    v("CVE-2026-1006", "curl", "7.88.1-10", "high", "7.88.1-10+deb12u8"),
    v("CVE-2026-1007", "libc6", "2.36-9", "high", ""),
  ];
  const detail: ImageDetail = {
    image: nginx,
    vulnerabilities: vulns,
    fix_groups: [
      {
        package: "openssl",
        installed_version: "3.0.11-1",
        fixed_in: ["3.0.14-1", "3.0.15-1"],
        counts: counts({ critical: 2, high: 2 }),
        fixable: 4,
        ids: ["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1003", "CVE-2026-1004"],
      },
      {
        package: "curl",
        installed_version: "7.88.1-10",
        fixed_in: ["7.88.1-10+deb12u8"],
        counts: counts({ high: 2 }),
        fixable: 2,
        ids: ["CVE-2026-1005", "CVE-2026-1006"],
      },
      {
        package: "libc6",
        installed_version: "2.36-9",
        fixed_in: [],
        counts: counts({ high: 1 }),
        fixable: 0,
        ids: ["CVE-2026-1007"],
      },
    ],
    ignored: [],
  };
  const images = [
    nginx,
    image({
      image: "redis:7.2",
      digest: "sha256:2222222222222222",
      counts: counts({ high: 2, low: 1 }),
      workloads: [w("StatefulSet", "demo", "cache", "redis")],
      report_namespace: "demo",
      report_name: "statefulset-cache-redis",
    }),
    image({
      image: "busybox:1.36",
      digest: "sha256:3333333333333333",
      workloads: [w("Deployment", "demo", "logger")],
      report_namespace: "demo",
      report_name: "replicaset-logger-busybox",
    }),
    image({
      image: "ghcr.io/team-a/app:2.1",
      digest: "sha256:4444444444444444",
      counts: counts({ medium: 4, low: 2 }),
      fixable: counts({ medium: 1 }),
      workloads: [w("Deployment", "team-a", "app")],
      report_namespace: "team-a",
      report_name: "replicaset-app-app",
    }),
    image({
      image: "postgres:15",
      digest: "sha256:5555555555555555",
      counts: counts({ critical: 1 }),
      fixable: counts({ critical: 1 }),
      workloads: [w("StatefulSet", "team-a", "db", "postgres")],
      report_namespace: "team-a",
      report_name: "statefulset-db-postgres",
      scanned_at: now() - 10 * 86400,
    }),
    image({
      image: "ghcr.io/team-a/worker:3",
      digest: "sha256:6666666666666666",
      scanned: false,
      scanner: "",
      scanned_at: 0,
      reports: 0,
      workloads: [w("Deployment", "team-a", "worker")],
    }),
  ];
  return {
    state: "ok",
    images,
    details: { [`${nginx.image}@${nginx.digest}`]: detail },
    forbidden: [],
    notes: [],
    kevIds: ["CVE-2026-1002"],
  };
}
