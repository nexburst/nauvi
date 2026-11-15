// Details, related objects, YAML, delete and apply (`commands/resources.rs`).

import type { ApplyResult, ResourceKind, ResourceRef, ResourceRow } from "../../lib/bindings";
import { detail, makeRow, NO_POD } from "../fixtures/cluster";
import { NO_RELATED } from "../fixtures/related";
import { addRow, findRow, removeRow, rowKey, rowsOf } from "./state";
import type { AreaHandlers, FakeState } from "./state";

function detailOf(s: FakeState, resource: ResourceRef, namespace: string, name: string) {
  const { kind, row } = findRow(s, resource, namespace, name);
  const known = s.cluster.details[`${kind.id}|${row.key}`];
  if (known) return known;
  return detail(kind, namespace, name, {
    uid: `uid-${row.key}`,
    created: row.created,
    secret_keys: kind.resource.kind === "Secret" ? [{ key: "password", bytes: 7 }] : [],
    pod: NO_POD,
  });
}

function defaultYaml(kind: ResourceKind, row: ResourceRow): string {
  const r = kind.resource;
  const lines = [
    `apiVersion: ${r.group ? `${r.group}/${r.version}` : r.version}`,
    `kind: ${r.kind}`,
    "metadata:",
    `  name: ${row.name}`,
  ];
  if (row.namespace) lines.push(`  namespace: ${row.namespace}`);
  if (r.kind === "Secret") lines.push("type: Opaque", "data:", "  password: <hidden>");
  return lines.join("\n") + "\n";
}

/**
 * A small stand-in for `apply_manifests`: documents split at `---`, the
 * identity read with regexes (block style, as the templates are written).
 */
function applyManifests(s: FakeState, yaml: string, namespace: string, dryRun: boolean, skipInvalid: boolean): ApplyResult[] {
  const { cluster } = s;
  const field = (doc: string, re: RegExp) => re.exec(doc)?.[1]?.trim() ?? "";
  const docs: { line: number; text: string }[] = [];
  let start = 1;
  let cur: string[] = [];
  yaml.split("\n").forEach((l, i) => {
    if (/^---(\s|$)/.test(l)) {
      docs.push({ line: start, text: cur.join("\n") });
      cur = [];
      start = i + 2;
    } else cur.push(l);
  });
  docs.push({ line: start, text: cur.join("\n") });
  const planned = docs
    .filter((d) => d.text.split("\n").some((l) => l.trim() && !l.trim().startsWith("#")))
    .map((d, i) => {
      const apiVersion = field(d.text, /^apiVersion:(.*)$/m);
      const kindName = field(d.text, /^kind:(.*)$/m);
      const name = field(d.text, /^ {2}name:(.*)$/m);
      const kind = cluster.kinds.find(
        (k) =>
          k.resource.kind === kindName &&
          (k.resource.group ? `${k.resource.group}/${k.resource.version}` : k.resource.version) === apiVersion,
      );
      const ns = kind?.resource.namespaced ? field(d.text, /^ {2}namespace:(.*)$/m) || namespace || "default" : "";
      const exists = kind ? rowsOf(s, kind).some((r) => r.key === rowKey(ns, name)) : false;
      const error = !kind
        ? `the cluster does not serve ${kindName} in ${apiVersion}`
        : (cluster.applyErrors[name] ?? "");
      const result: ApplyResult = {
        document: i + 1,
        line: d.line,
        api_version: apiVersion,
        kind: kindName,
        name,
        namespace: ns,
        status: error ? "failed" : exists ? "unchanged" : "created",
        message: error,
        takeovers: [],
      };
      return { result, kind };
    });
  const failed = planned.filter((p) => p.result.status === "failed").length;
  if (dryRun) return planned.map((p) => p.result);
  if (failed && !skipInvalid) {
    return planned.map((p) =>
      p.result.status === "failed"
        ? p.result
        : { ...p.result, status: "skipped" as const, message: `not applied: ${failed} document(s) failed validation` },
    );
  }
  for (const p of planned) {
    if (p.kind && p.result.status === "created") addRow(s, p.kind, makeRow(cluster.kinds, p.kind.id, p.result.namespace, p.result.name, {}, Math.floor(Date.now() / 1000)));
  }
  return planned.map((p) => p.result);
}

/** Set `metadata.resourceVersion` the way the server reports it (after name / namespace). */
function withResourceVersion(yaml: string, rv: number): string {
  const line = `  resourceVersion: "${rv}"\n`;
  if (/^ {2}resourceVersion: .*\n/m.test(yaml)) return yaml.replace(/^ {2}resourceVersion: .*\n/m, line);
  return yaml.replace(/^(metadata:\n {2}name: .*\n(?: {2}namespace: .*\n)?)/m, `$1${line}`);
}

export function resourcesHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdGetResourceDetail: (resource, namespace, name) => detailOf(s, resource, namespace, name),
    cmdGetRelated: (resource, namespace, name) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      // A copy, like real IPC: tests change the fixture in place.
      return structuredClone(cluster.related[`${kind.id}|${row.key}`] ?? NO_RELATED);
    },
    cmdGetResourceYaml: (resource, namespace, name, reveal) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      const key = `${kind.id}|${row.key}`;
      const yaml = (reveal && cluster.revealedYaml[key]) || cluster.yaml[key] || defaultYaml(kind, row);
      return withResourceVersion(yaml, cluster.resourceVersions[key] ?? 1);
    },
    cmdApplyResourceYaml: (resource, namespace, name, yaml, resourceVersion, dryRun) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      const key = `${kind.id}|${row.key}`;
      const current = String(cluster.resourceVersions[key] ?? 1);
      if (resourceVersion && resourceVersion !== current) {
        return { outcome: "conflict", resource_version: current };
      }
      // A dry run reports what the save would take over, without using it up.
      if (dryRun) return { outcome: "applied", takeovers: cluster.nextTakeovers };
      cluster.yaml[key] = yaml;
      cluster.resourceVersions[key] = Number(current) + 1;
      const took = cluster.nextTakeovers;
      cluster.nextTakeovers = [];
      return { outcome: "applied", takeovers: took };
    },
    cmdApplyManifests: (yaml, namespace, dryRun, skipInvalid) => applyManifests(s, yaml, namespace, dryRun, skipInvalid),
    cmdDeleteResource: (resource, namespace, name) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      removeRow(s, kind, row.key);
      return null;
    },
  } satisfies AreaHandlers;
}
