// Image security (#534, ADR 0011): the words and the order of the Image
// security view. The backend (`commands/image_security.rs`) lists the
// images and the Trivy Operator's counts; this decides what a row says,
// with the settings' severity, "only fixable" and excluded namespaces.
// Never "problems": no pill, no notification, and red only for a critical
// vulnerability that has a fix.

import type {
  FixGroup,
  ImageSecurityMode,
  ImageSecuritySettings_Serialize as ImageSecuritySettings,
  ImageVulns,
  ScanSource,
  Severity,
  SeverityCounts,
  Vulnerability,
  VulnsSummary,
  Workload,
} from "./bindings";
import { triageParts } from "./imageTriage";

export const IMAGE_SECURITY_VIEW = "image-security";

/** Worst first. */
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];

const RANK: Record<Severity, number> = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** After this long a report is old: the operator may have stopped scanning. */
export const STALE_SECS = 7 * 24 * 3600;

export const DEFAULT_IMAGE_SECURITY: ImageSecuritySettings = {
  enabled: false,
  min_severity: "high",
  only_fixable: false,
  excluded_namespaces: [],
  cache_ttl_hours: 24,
  source: "cluster",
  scanner: "trivy",
  db_repository: "",
  skip_db_update: false,
  server_url: "",
  ignore_file: "",
  ignores: [],
  kev_download: false,
};

/** The cache hours offered in Settings. */
export const CACHE_TTL_CHOICES = [1, 6, 12, 24, 72, 168];

export function cacheTtlLabel(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "1 day" : `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The severities Settings offers as the least to count, with their names. */
export const MIN_SEVERITIES: { value: Severity; label: string }[] = [
  { value: "critical", label: "Critical only" },
  { value: "high", label: "High and critical" },
  { value: "medium", label: "Medium and worse" },
  { value: "low", label: "Low and worse" },
  { value: "unknown", label: "All" },
];

/** Whether the reports are read for a cluster: its own choice, else the app's. */
export function imageSecurityOn(app: ImageSecuritySettings, mode: ImageSecurityMode | undefined): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return app.enabled;
}

/** How many of `c` are `min` or worse. */
export function atLeast(c: SeverityCounts, min: Severity): number {
  return SEVERITIES.filter((s) => RANK[s] >= RANK[min]).reduce((n, s) => n + c[s], 0);
}

/** `c` with only `min` or worse. */
function only(c: SeverityCounts, min: Severity): SeverityCounts {
  const out = { ...c };
  for (const s of SEVERITIES) if (RANK[s] < RANK[min]) out[s] = 0;
  return out;
}

/** The counts a row is judged by: its findings (or only those with a fix), `min` or worse. */
export function countedOf(row: ImageVulns, s: ImageSecuritySettings): SeverityCounts {
  // Kubescape's summaries do not say which have a fix: count them all.
  return only(s.only_fixable && row.fixes_known ? row.fixable : row.counts, s.min_severity);
}

/** `2 critical and 5 high`, `1 medium`. */
export function countsText(c: SeverityCounts): string {
  const parts = SEVERITIES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What `min` or worse is called in a sentence. */
function scopeWords(min: Severity): string {
  switch (min) {
    case "critical":
      return "critical";
    case "high":
      return "high or critical";
    case "medium":
      return "medium, high or critical";
    case "low":
      return "low or worse";
    default:
      return "known";
  }
}

export type Tone = "critical" | "high" | "neutral";

export interface Verdict {
  /** `findings`: something to count; `clean`: nothing at this severity; `unscanned`: no report. */
  kind: "findings" | "clean" | "unscanned";
  tone: Tone;
  text: string;
  /** How many are counted, and how many of those have a fix. */
  counted: number;
  fixable: number;
}

/** The sentence a row leads with: "2 critical and 5 high. 6 of 7 have a fix."
 *  Known exploited findings (#537) come first and make it red, whatever the
 *  severity counted; ignored ones are counted at the end. */
export function verdict(row: ImageVulns, s: ImageSecuritySettings): Verdict {
  const v = countVerdict(row, s);
  const t = triageParts(row, s.min_severity);
  if (t.kev) Object.assign(v, { kind: "findings", tone: "critical", text: `${t.kev} ${v.text}` });
  if (t.ignored) v.text = `${v.text} ${t.ignored}`;
  return v;
}

function countVerdict(row: ImageVulns, s: ImageSecuritySettings): Verdict {
  if (!row.scanned) return { kind: "unscanned", tone: "neutral", text: "Not scanned yet.", counted: 0, fixable: 0 };
  const counted = countedOf(row, s);
  const n = atLeast(counted, "unknown");
  const fixable = atLeast(only(row.fixable, s.min_severity), "unknown");
  if (n === 0) {
    const lower = atLeast(row.counts, "unknown");
    const text =
      lower === 0
        ? "No known vulnerabilities."
        : s.only_fixable && row.fixes_known
          ? `No ${scopeWords(s.min_severity)} vulnerabilities with a fix.`
          : `No ${scopeWords(s.min_severity)} vulnerabilities; ${lower} lower ${lower === 1 ? "one" : "ones"}.`;
    return { kind: "clean", tone: "neutral", text, counted: 0, fixable: 0 };
  }
  if (!row.fixes_known) {
    const tone: Tone = counted.critical + counted.high > 0 ? "high" : "neutral";
    return { kind: "findings", tone, text: `${countsText(counted)}. Open it to see which have a fix.`, counted: n, fixable: 0 };
  }
  let fix: string;
  if (s.only_fixable) fix = n === 1 ? "It has a fix." : "Each has a fix.";
  else if (fixable === 0) fix = n === 1 ? "It has no fix yet." : "None has a fix yet.";
  else if (fixable === n) fix = n === 1 ? "It has a fix." : `All ${n} have a fix.`;
  else fix = `${fixable} of ${n} ${fixable === 1 ? "has" : "have"} a fix.`;
  const tone: Tone =
    row.fixable.critical > 0 && RANK[s.min_severity] <= RANK.critical
      ? "critical"
      : counted.critical + counted.high > 0
        ? "high"
        : "neutral";
  return { kind: "findings", tone, text: `${countsText(counted)}. ${fix}`, counted: n, fixable };
}

/** A row of the view: the image and what it says. */
export interface ImageRow {
  key: string;
  row: ImageVulns;
  verdict: Verdict;
  /** Its workloads outside the excluded namespaces. */
  workloads: Workload[];
}

export const rowKey = (r: Pick<ImageVulns, "image" | "digest">) => `${r.image}@${r.digest}`;

/** The rows to show: excluded namespaces left out, the search applied,
 *  findings first (worst first), then clean images, then the unscanned. */
export function imageRows(images: readonly ImageVulns[], s: ImageSecuritySettings, search = ""): ImageRow[] {
  const excluded = new Set(s.excluded_namespaces);
  const needle = search.trim().toLowerCase();
  const out: ImageRow[] = [];
  for (const row of images) {
    const workloads = row.workloads.filter((w) => !excluded.has(w.namespace));
    if (row.workloads.length > 0 && workloads.length === 0) continue;
    if (
      needle &&
      !row.image.toLowerCase().includes(needle) &&
      !workloads.some((w) => `${w.namespace}/${w.name}`.toLowerCase().includes(needle))
    )
      continue;
    out.push({ key: rowKey(row), row, verdict: verdict(row, s), workloads });
  }
  const order = { findings: 0, clean: 1, unscanned: 2 };
  const tone = { critical: 0, high: 1, neutral: 2 };
  out.sort((a, b) => {
    const k = order[a.verdict.kind] - order[b.verdict.kind];
    if (k) return k;
    const t = tone[a.verdict.tone] - tone[b.verdict.tone];
    if (t) return t;
    const ca = countedOf(a.row, s);
    const cb = countedOf(b.row, s);
    for (const sev of SEVERITIES) if (ca[sev] !== cb[sev]) return cb[sev] - ca[sev];
    return a.row.image.localeCompare(b.row.image);
  });
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The headline counts images, not CVEs: "3 images have fixes waiting". */
export function headline(rows: readonly ImageRow[]): string {
  const waiting = rows.filter((r) => r.verdict.kind === "findings" && r.verdict.fixable > 0).length;
  if (waiting > 0) return `${waiting} ${plural(waiting, "image has a fix", "images have fixes")} waiting`;
  // Kubescape: whether they have a fix is known only per image.
  const unknown = rows.filter((r) => r.verdict.kind === "findings" && !r.row.fixes_known).length;
  if (unknown > 0) return `${unknown} ${plural(unknown, "image has", "images have")} known vulnerabilities`;
  if (rows.some((r) => r.verdict.kind === "findings")) return "No fixes waiting";
  if (rows.length > 0 && rows.every((r) => r.verdict.kind === "unscanned")) return "Not scanned yet";
  return "No known vulnerabilities";
}

/** The line under the headline: how many images, how many not scanned. */
export function headlineDetail(rows: readonly ImageRow[], s: ImageSecuritySettings): string {
  const scanned = rows.filter((r) => r.verdict.kind !== "unscanned").length;
  const unscanned = rows.length - scanned;
  const findings = rows.filter((r) => r.verdict.kind === "findings").length;
  const parts = [`${rows.length} ${plural(rows.length, "image", "images")}`];
  if (findings > 0)
    parts.push(`${findings} with ${scopeWords(s.min_severity)} vulnerabilities${s.only_fixable ? " that have a fix" : ""}`);
  if (unscanned > 0) parts.push(`${unscanned} not scanned yet`);
  return parts.join(", ") + ".";
}

/** The parts of a version, numbers as numbers: `3.0.15-1` → [3, 0, 15, 1]. */
function versionParts(v: string): (number | string)[] {
  return v.split(/[^0-9A-Za-z]+/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** Compare two versions part by part, numbers by value. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** What to do about one package: "Updating openssl to 3.0.15-1 fixes 4 (2 critical)." */
export function fixSentence(g: FixGroup, vulns: readonly Vulnerability[]): string {
  const target = [...g.fixed_in].sort(compareVersions).pop() ?? "";
  const fixed = vulns.filter(
    (v) => v.package === g.package && v.installed_version === g.installed_version && v.fixed_version !== "",
  );
  const worst = SEVERITIES.find((s) => fixed.some((v) => v.severity === s));
  const worstCount = worst ? fixed.filter((v) => v.severity === worst).length : 0;
  const total = atLeast(g.counts, "unknown");
  let what = total > g.fixable ? `${g.fixable} of ${total}` : String(g.fixable);
  if (worst === "critical" || worst === "high") {
    what += worstCount === g.fixable ? ` ${worst}` : ` (${worstCount} ${worst})`;
  }
  return `Updating ${g.package} to ${target} fixes ${what}.`;
}

/** The groups split: what an update fixes, worst first, and what has no fix yet. */
export function splitGroups(groups: readonly FixGroup[]): { fixable: FixGroup[]; noFix: FixGroup[] } {
  return { fixable: groups.filter((g) => g.fixable > 0), noFix: groups.filter((g) => g.fixable === 0) };
}

/** A time ago in words: "5 minutes ago", "2 days ago". */
export function agoText(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const units: [number, string][] = [
    [86400 * 365, "year"],
    [86400 * 30, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** Where the data comes from and how old it is: "Trivy 0.69.3 through Trivy Operator, 2 days ago". */
export function sourceText(row: ImageVulns, nowSecs: number): { text: string; stale: boolean } {
  const kubescape = row.source === "kubescape";
  const local = row.source === "local_scanner";
  if (!row.scanned) {
    const text = local
      ? "Not scanned on this computer yet"
      : kubescape
        ? "No Kubescape scan for it yet"
        : "No VulnerabilityReport for it yet";
    return { text, stale: false };
  }
  const age = row.scanned_at > 0 ? nowSecs - row.scanned_at : 0;
  const when = row.scanned_at > 0 ? `, ${agoText(age)}` : "";
  const scanner = row.scanner || "Trivy";
  const text = kubescape
    ? `Kubescape scan${when}`
    : `${scanner} ${local ? "on this computer" : "through Trivy Operator"}${when}`;
  return { text, stale: row.scanned_at > 0 && age > STALE_SECS };
}

/** The resource a source's listing reads, as RBAC names it. */
export function reportsResource(source: ScanSource): string {
  return source === "kubescape"
    ? "vulnerabilitymanifestsummaries.spdx.softwarecomposition.kubescape.io"
    : "vulnerabilityreports.aquasecurity.github.io";
}

const SHORT_KIND: Record<string, string> = {
  Deployment: "deploy",
  StatefulSet: "sts",
  DaemonSet: "ds",
  ReplicaSet: "rs",
  Job: "job",
  CronJob: "cronjob",
  Pod: "pod",
};

/** "deploy/web, pod/static in shop", at most three and "+2 more". */
export function workloadsText(workloads: readonly Workload[]): string {
  const names: string[] = [];
  for (const w of workloads) {
    const t = `${SHORT_KIND[w.kind] ?? w.kind.toLowerCase()}/${w.name}`;
    if (!names.includes(t)) names.push(t);
  }
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  const namespaces = [...new Set(workloads.map((w) => w.namespace))];
  const where = namespaces.length === 1 ? ` in ${namespaces[0]}` : ` in ${namespaces.length} namespaces`;
  return shown + more + where;
}

/** "namespace demo", "namespaces a and b", "any namespace". */
function namespacesText(list: readonly string[]): string {
  if (list.length === 0) return "any namespace";
  if (list.length === 1) return `namespace ${list[0]}`;
  return `namespaces ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** Why there is nothing to list, or `null` when there is a list. */
export function stateMessage(summary: VulnsSummary): { title: string; detail: string; reason: string } | null {
  switch (summary.state) {
    case "no_operator":
      return {
        reason: "no-operator",
        title: "This cluster has no Trivy Operator reports",
        detail:
          "It does not serve VulnerabilityReports (aquasecurity.github.io), nor Kubescape's VulnerabilityManifestSummaries. nauvi shows the scans the Trivy Operator (or Kubescape) makes in the cluster; install one there to see which images have known vulnerabilities.",
      };
    case "forbidden":
      return {
        reason: "forbidden",
        title: `You are not allowed to list ${reportsResource(summary.source).split(".")[0]} in ${namespacesText(summary.forbidden_namespaces)}`,
        detail: `Ask for list access to ${reportsResource(summary.source)}, or pick a namespace you may read.`,
      };
    case "no_reports":
      return {
        reason: "no-reports",
        title: "Not scanned yet",
        detail:
          summary.source === "kubescape"
            ? "Kubescape is installed but has no VulnerabilityManifestSummaries here yet. It scans new workloads within minutes; check that its vulnerability scanning is on for these namespaces."
            : "The Trivy Operator is installed but has no VulnerabilityReports here yet. It scans new workloads within minutes; check that it watches these namespaces.",
      };
    default:
      return null;
  }
}

/** The backend's notes, in the app's words, and the namespaces that could not be read. */
export function viewNotes(summary: VulnsSummary): string[] {
  const notes = summary.notes.map((n) => n.replace(/; narrow with -n\.$/, "; pick fewer namespaces to see the rest."));
  // A local listing's notes already say where the pods could not be read.
  if (summary.source !== "local_scanner" && (summary.state === "ok" || summary.state === "no_reports")) {
    if (summary.forbidden_namespaces.length > 0)
      notes.unshift(
        `You are not allowed to list ${reportsResource(summary.source).split(".")[0]} in ${namespacesText(summary.forbidden_namespaces)}.`,
      );
  }
  return notes;
}
