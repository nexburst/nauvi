// Ignores and exploit signals of image security (#537): the words for an
// ignore's scope and expiry, the rule the panel's form makes, and what a
// row's verdict adds ("4 ignored", "known to be exploited in the wild").
// The backend (`image_security::triage`) applies them; this only says it.

import type {
  IgnoreRule_Serialize as IgnoreRule,
  IgnoreScope,
  ImageVulns,
  Severity,
  SeverityCounts,
  Vulnerability,
  Workload,
} from "./bindings";

/** The words CISA's catalogue is shown with. */
export const KEV_WORDS = "Known to be exploited in the wild";

const RANK: Record<Severity, number> = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };
const ALL: Severity[] = ["critical", "high", "medium", "low", "unknown"];

/** How many of `c` are `min` or worse. */
export function ignoredAtLeast(c: SeverityCounts, min: Severity): number {
  return ALL.filter((s) => RANK[s] >= RANK[min]).reduce((n, s) => n + c[s], 0);
}

/** The expiries the form offers, in days (0: never). */
export const EXPIRY_CHOICES: { days: number; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: 0, label: "Never" },
];

/** "until 3 Mar 2027", "expired on 1 Jan 2026", "" for never. */
export function expiryText(expires: number, nowSecs: number): string {
  if (!expires) return "";
  const day = new Date(expires * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return expires <= nowSecs ? `expired on ${day}` : `until ${day}`;
}

/** Whether an ignore still applies. */
export function ignoreActive(r: Pick<IgnoreRule, "expires">, nowSecs: number): boolean {
  return r.expires === 0 || nowSecs < r.expires;
}

/** The repository of an image (what an image ignore covers): `nginx` for `nginx:1.27`. */
export function repositoryOf(image: string): string {
  const name = image.split("@")[0];
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  return colon > slash ? name.slice(0, colon) : name;
}

/** What an ignore covers, in words: "every nginx image", "deploy web in shop". */
export function scopeText(r: Pick<IgnoreRule, "scope" | "image" | "namespace" | "kind" | "name">): string {
  switch (r.scope) {
    case "image":
      return `every ${repositoryOf(r.image)} image`;
    case "workload":
      return `${r.kind} ${r.name} in ${r.namespace}`;
    case "namespace":
      return `namespace ${r.namespace}`;
    default:
      return "everywhere";
  }
}

/** The scopes the form offers for `row`: its image, its one workload, its one namespace. */
export function scopeChoices(row: Pick<ImageVulns, "image" | "workloads">): { scope: IgnoreScope; label: string }[] {
  const out: { scope: IgnoreScope; label: string }[] = [
    { scope: "image", label: `Every ${repositoryOf(row.image)} image` },
  ];
  const workloads = uniqueWorkloads(row.workloads);
  if (workloads.length === 1) {
    const w = workloads[0];
    out.push({ scope: "workload", label: `${w.kind} ${w.name} only` });
  }
  const namespaces = [...new Set(row.workloads.map((w) => w.namespace))];
  if (namespaces.length === 1) out.push({ scope: "namespace", label: `Namespace ${namespaces[0]}` });
  return out;
}

function uniqueWorkloads(list: readonly Workload[]): Workload[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = `${w.namespace}/${w.kind}/${w.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The rule the form makes. `context`: the cluster, for a workload or namespace ignore. */
export function makeRule(
  id: string,
  scope: IgnoreScope,
  row: Pick<ImageVulns, "image" | "workloads">,
  reason: string,
  days: number,
  context: string,
  nowSecs: number,
): IgnoreRule {
  const w = uniqueWorkloads(row.workloads)[0];
  const rule: IgnoreRule = {
    id: id.trim(),
    scope,
    context: scope === "image" ? "" : context,
    image: scope === "image" ? row.image : "",
    namespace: scope === "image" ? "" : (w?.namespace ?? ""),
    kind: scope === "workload" ? (w?.kind ?? "") : "",
    name: scope === "workload" ? (w?.name ?? "") : "",
    reason: reason.trim(),
    expires: days > 0 ? nowSecs + days * 86400 : 0,
    added: nowSecs,
    from_file: false,
  };
  return rule;
}

/** Whether two ignores are about the same thing (the backend keeps the later one). */
export function sameTarget(a: IgnoreRule, b: IgnoreRule): boolean {
  return (
    a.id.toLowerCase() === b.id.toLowerCase() &&
    a.scope === b.scope &&
    a.context === b.context &&
    (a.scope !== "image" || repositoryOf(a.image) === repositoryOf(b.image)) &&
    a.namespace === b.namespace &&
    a.kind === b.kind &&
    a.name === b.name
  );
}

/** What a row's verdict adds: KEV first, the ignored count last. */
export function triageParts(row: Pick<ImageVulns, "kev" | "ignored" | "scanned">, min: Severity) {
  if (!row.scanned) return { kev: "", ignored: "" };
  const ignored = ignoredAtLeast(row.ignored, min);
  return {
    kev: row.kev > 0 ? `${row.kev} known to be exploited in the wild.` : "",
    ignored: ignored > 0 ? `${ignored} ignored.` : "",
  };
}

/** "EPSS 12% (top 5%)": how likely it is to be exploited, as Grype says; "" without one. */
export function epssText(v: Pick<Vulnerability, "exploit">): string {
  const p = v.exploit.epss ?? 0;
  if (!(p > 0)) return "";
  const pct = p >= 0.1 ? Math.round(p * 100) : Math.round(p * 1000) / 10;
  const q = v.exploit.epss_percentile ?? 0;
  const top = q > 0 ? ` (top ${Math.max(1, Math.round((1 - q) * 100))}%)` : "";
  return `EPSS ${pct}%${top}`;
}

/** The findings most likely to be exploited, as the scanner rates them (EPSS), at most `n`. */
export function likeliest(vulns: readonly Vulnerability[], n = 5): Vulnerability[] {
  return vulns
    .filter((v) => (v.exploit.epss ?? 0) > 0)
    .sort((a, b) => (b.exploit.epss ?? 0) - (a.exploit.epss ?? 0))
    .slice(0, n);
}

/** "Catalogue 2026.11.25, 1805 vulnerabilities, downloaded 2 hours ago". */
export function kevStatusText(version: string, count: number, ago: string): string {
  return `Catalogue ${version || "of unknown date"}, ${count} vulnerabilities, downloaded ${ago}.`;
}
