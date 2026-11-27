// Misconfigurations (#538): the words and the order of the Configuration
// tab of the Image security view. The backend
// (`commands/image_config.rs`) lists the workloads with the checks the
// Trivy Operator's ConfigAuditReports say they fail; this decides what a
// row says, with the settings' severity and excluded namespaces. Never
// "problems": no pill, no notification.

import type {
  ConfigCheck,
  ConfigSummary,
  ImageSecuritySettings_Serialize as ImageSecuritySettings,
  Severity,
  SeverityCounts,
  WorkloadConfig,
} from "./bindings";
import {
  agoText,
  atLeast,
  countsText,
  SEVERITIES,
  STALE_SECS,
} from "./imageSecurity";

const RANK: Record<Severity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** The tabs of the Image security view. */
export type ImageSecurityTab = "images" | "config";

/** `c` with only `min` or worse. */
function only(c: SeverityCounts, min: Severity): SeverityCounts {
  const out = { ...c };
  for (const s of SEVERITIES) if (RANK[s] < RANK[min]) out[s] = 0;
  return out;
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
    default:
      return "";
  }
}

export interface ConfigVerdict {
  /** `changes`: checks to act on at this severity; `clean`: none. */
  kind: "changes" | "clean";
  tone: "critical" | "high" | "neutral";
  text: string;
  counted: number;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Fails 1 high check.", "Fails 3 checks: 1 high and 2 medium.", "Passes every check." */
export function configVerdict(
  row: WorkloadConfig,
  s: ImageSecuritySettings,
): ConfigVerdict {
  const counted = only(row.failed, s.min_severity);
  const n = atLeast(counted, "unknown");
  if (n === 0) {
    const all = atLeast(row.failed, "unknown");
    const words = scopeWords(s.min_severity);
    const text =
      all === 0
        ? "Passes every check."
        : `No ${words} checks fail; ${all} lower ${plural(all, "one", "ones")}.`;
    return { kind: "clean", tone: "neutral", text, counted: 0 };
  }
  const tone =
    counted.critical > 0 ? "critical" : counted.high > 0 ? "high" : "neutral";
  const severities = SEVERITIES.filter((sev) => counted[sev] > 0);
  const text =
    severities.length === 1
      ? `Fails ${n} ${severities[0]} ${plural(n, "check", "checks")}.`
      : `Fails ${n} checks: ${countsText(counted)}.`;
  return { kind: "changes", tone, text, counted: n };
}

export interface ConfigRow {
  key: string;
  row: WorkloadConfig;
  verdict: ConfigVerdict;
}

export const configKey = (r: Pick<WorkloadConfig, "target">) =>
  `${r.target.kind}/${r.target.namespace}/${r.target.name}`;

/** The rows to show: excluded namespaces left out, the search applied,
 *  workloads with checks to act on first (worst first), then the rest. */
export function configRows(
  rows: readonly WorkloadConfig[],
  s: ImageSecuritySettings,
  search = "",
): ConfigRow[] {
  const excluded = new Set(s.excluded_namespaces);
  const needle = search.trim().toLowerCase();
  const out: ConfigRow[] = [];
  for (const row of rows) {
    if (excluded.has(row.target.namespace)) continue;
    const t = row.target;
    if (
      needle &&
      !`${t.kind}/${t.namespace}/${t.name}`.toLowerCase().includes(needle)
    )
      continue;
    out.push({ key: configKey(row), row, verdict: configVerdict(row, s) });
  }
  const tone = { critical: 0, high: 1, neutral: 2 };
  out.sort((a, b) => {
    if (a.verdict.kind !== b.verdict.kind)
      return a.verdict.kind === "changes" ? -1 : 1;
    const t = tone[a.verdict.tone] - tone[b.verdict.tone];
    if (t) return t;
    for (const sev of SEVERITIES)
      if (a.row.failed[sev] !== b.row.failed[sev])
        return b.row.failed[sev] - a.row.failed[sev];
    return configKey(a.row).localeCompare(configKey(b.row));
  });
  return out;
}

/** "2 workloads have settings to change", "Nothing to change". */
export function configHeadline(rows: readonly ConfigRow[]): string {
  const n = rows.filter((r) => r.verdict.kind === "changes").length;
  if (n === 0) return "Nothing to change";
  return `${n} ${plural(n, "workload has", "workloads have")} settings to change`;
}

/** "5 workloads, 2 with high or critical checks failing." */
export function configHeadlineDetail(
  rows: readonly ConfigRow[],
  s: ImageSecuritySettings,
): string {
  const n = rows.filter((r) => r.verdict.kind === "changes").length;
  const parts = [
    `${rows.length} ${plural(rows.length, "workload", "workloads")}`,
  ];
  const words = scopeWords(s.min_severity);
  if (n > 0) parts.push(`${n} failing ${words ? `${words} ` : ""}checks`);
  return parts.join(", ") + ".";
}

/** "Trivy 0.69.3 through Trivy Operator, 2 days ago". */
export function configSourceText(
  row: WorkloadConfig,
  nowSecs: number,
): { text: string; stale: boolean } {
  const scanner = row.scanner || "Trivy";
  const age = row.scanned_at > 0 ? nowSecs - row.scanned_at : 0;
  const when = row.scanned_at > 0 ? `, ${agoText(age)}` : "";
  return {
    text: `${scanner} through Trivy Operator${when}`,
    stale: row.scanned_at > 0 && age > STALE_SECS,
  };
}

const SHORT_KIND: Record<string, string> = {
  Deployment: "deploy",
  StatefulSet: "sts",
  DaemonSet: "ds",
  ReplicaSet: "rs",
  Job: "job",
  CronJob: "cronjob",
  Pod: "pod",
  Service: "svc",
  ConfigMap: "cm",
};

/** `deploy/web` */
export function targetText(row: WorkloadConfig): string {
  const k = row.target.kind;
  return `${SHORT_KIND[k] ?? k.toLowerCase()}/${row.target.name}`;
}

/** The failed checks split: at the settings' severity or worse, and the lower ones. */
export function splitChecks(
  checks: readonly ConfigCheck[],
  s: ImageSecuritySettings,
): { counted: ConfigCheck[]; lower: ConfigCheck[] } {
  const min = RANK[s.min_severity];
  return {
    counted: checks.filter((c) => RANK[c.severity] >= min),
    lower: checks.filter((c) => RANK[c.severity] < min),
  };
}

/** Why there is nothing to list, or `null` when there is a list. */
export function configStateMessage(
  summary: ConfigSummary,
): { title: string; detail: string; reason: string } | null {
  const where = (list: readonly string[]) =>
    list.length === 0
      ? "any namespace"
      : list.length === 1
        ? `namespace ${list[0]}`
        : `namespaces ${list.join(", ")}`;
  switch (summary.state) {
    case "no_operator":
      return {
        reason: "no-operator",
        title: "This cluster has no configuration audits",
        detail:
          "It does not serve ConfigAuditReports (aquasecurity.github.io). The Trivy Operator writes them: it checks each workload's settings, such as limits, probes and security context. Install it to see what to change.",
      };
    case "forbidden":
      return {
        reason: "forbidden",
        title: `You are not allowed to list configauditreports in ${where(summary.forbidden_namespaces)}`,
        detail:
          "Ask for list access to configauditreports.aquasecurity.github.io, or pick a namespace you may read.",
      };
    case "no_reports":
      return {
        reason: "no-reports",
        title: "Not checked yet",
        detail:
          "The Trivy Operator is installed but has no ConfigAuditReports here yet. It checks new workloads within minutes; check that it watches these namespaces.",
      };
    default:
      return null;
  }
}

/** The backend's notes, in the app's words. */
export function configNotes(summary: ConfigSummary): string[] {
  const notes = summary.notes.map((n) =>
    n.replace(
      /; narrow with -n\.$/,
      "; pick fewer namespaces to see the rest.",
    ),
  );
  if (summary.forbidden_namespaces.length > 0 && summary.state === "ok")
    notes.unshift(
      `You are not allowed to list configauditreports in ${summary.forbidden_namespaces.join(", ")}.`,
    );
  return notes;
}
