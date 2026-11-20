// Readable labels for long kubeconfig context names (#383). Cloud tools name
// contexts after the whole cluster identity (an EKS ARN, GKE's
// `gke_project_zone_name`), so two clusters of one account look the same
// once the end is cut off. The label is the cluster's own name, qualified
// only as far as needed to tell it from the others; any other long name is
// cut in the middle, so its distinctive end stays visible. The full name is
// always in the tooltip, and a label the user set (the catalog) still wins.

/** Labels longer than this are cut in the middle. */
export const MAX_LABEL = 24;

/** A context name a cloud tool wrote: the cluster's name, and what tells
 *  two clusters of that name apart, most telling first. */
export interface CloudName {
  name: string;
  qualifiers: string[];
}

const EKS_ARN = /^arn:aws[a-z-]*:eks:([^:]+):([^:]*):cluster\/(.+)$/;
/** eksctl: `user@cluster.region.eksctl.io`. */
const EKSCTL = /^(.+)@([^@.]+)\.([a-z0-9-]+)\.eksctl\.io$/;
/** GKE: project ids and zones have no underscores. */
const GKE = /^gke_([^_]+)_([^_]+)_(.+)$/;
/** An AKS (or any Azure) resource id. */
const AKS_ID = /^\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\/providers\/microsoft\.containerservice\/managedclusters\/([^/]+)$/i;

/** The cluster name inside a cloud tool's context name, or null. */
export function parseCloudName(id: string): CloudName | null {
  let m = EKS_ARN.exec(id);
  if (m) return { name: m[3], qualifiers: [m[1], m[2]].filter(Boolean) };
  m = EKSCTL.exec(id);
  if (m) return { name: m[2], qualifiers: [m[3], m[1]] };
  m = GKE.exec(id);
  if (m) return { name: m[3], qualifiers: [m[2], m[1]] };
  m = AKS_ID.exec(id);
  if (m) return { name: m[3], qualifiers: [m[2], m[1]] };
  return null;
}

/** `text` cut to `max` characters in the middle, keeping more of the end. */
export function middleTruncate(text: string, max = MAX_LABEL): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const keep = max - 1;
  const head = Math.floor(keep * 0.4);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}

/** The short label of each context in `ids`, different for every one of
 *  them (a label that would repeat another is qualified, or else the full
 *  name). */
export function shortLabels(ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  const parsed = new Map(unique.map((id) => [id, parseCloudName(id)]));
  const first = (id: string) => middleTruncate(parsed.get(id)?.name ?? id);

  const byLabel = new Map<string, string[]>();
  for (const id of unique) {
    const l = first(id);
    byLabel.set(l, [...(byLabel.get(l) ?? []), id]);
  }
  for (const [l, group] of byLabel) {
    if (group.length === 1) {
      out.set(group[0], l);
      continue;
    }
    // A plain name keeps its label if it is the only one; cloud names get
    // as many qualifiers as tell them apart.
    const plain = group.filter((id) => !parsed.get(id));
    if (plain.length === 1) out.set(plain[0], l);
    else for (const id of plain) out.set(id, id);
    const cloud = group.filter((id) => parsed.get(id));
    const depth = Math.max(0, ...cloud.map((id) => parsed.get(id)!.qualifiers.length));
    let labels = new Map<string, string>();
    for (let n = 1; n <= depth; n++) {
      labels = new Map(cloud.map((id) => [id, qualified(parsed.get(id)!, n)]));
      if (new Set(labels.values()).size === cloud.length) break;
    }
    const seen = new Set(labels.values());
    for (const id of cloud) {
      const q = labels.get(id);
      out.set(id, q && seen.size === cloud.length ? q : id);
    }
  }
  // A qualified label must not repeat a name shown elsewhere either.
  const counts = new Map<string, number>();
  for (const l of out.values()) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const [id, l] of out) if ((counts.get(l) ?? 0) > 1) out.set(id, id);
  return out;
}

function qualified(c: CloudName, n: number): string {
  const q = c.qualifiers.slice(0, n);
  return q.length ? `${middleTruncate(c.name)} (${q.join(", ")})` : middleTruncate(c.name);
}
