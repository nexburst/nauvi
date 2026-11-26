// Helm chart repositories for the fake backend (#80): what each repository
// URL serves, the configured repositories, and install/upgrade into the
// fake releases (`FakeHelm.revisions`).

import type {
  HelmChartDetails,
  HelmChartVersion,
  HelmDeployRequest,
  HelmDeployResult,
  HelmRepo,
  HelmRepoUpdate,
} from "../../lib/bindings";
import type { FakeHelm } from "./helm";
import { HIDDEN, manifest, notFound, revision, storedIn } from "./helm";

export interface FakeChart {
  /** Without the repository. */
  name: string;
  version: string;
  app_version: string;
  description: string;
  readme: string;
  values: string;
}

export interface FakeCharts {
  /** The configured repositories (`helm repo list`). */
  repos: HelmRepo[];
  /** What each reachable URL serves, newest version first per chart. */
  servers: Record<string, FakeChart[]>;
  /** Namespaces that exist, beyond the cluster's list (created by installs). */
  created: string[];
}

const STABLE = "https://charts.example.com/stable";
export const MORE = "https://charts.example.com/more";

function chart(name: string, version: string, app: string, description: string): FakeChart {
  return {
    name,
    version,
    app_version: app,
    description,
    readme: `# ${name}\n\n${description}\n`,
    values: `greeting: hello\nreplicas: 1\n# ${name} ${version}\n`,
  };
}

export function defaultCharts(): FakeCharts {
  return {
    repos: [{ name: "example", url: STABLE }],
    servers: {
      [STABLE]: [
        chart("web", "1.3.0", "2.5", "A small web server"),
        chart("web", "1.2.0", "2.4", "A small web server"),
        chart("redis", "18.0.0", "7.2", "An in-memory data store"),
      ],
      [MORE]: [chart("cache", "0.4.0", "1.0", "A cache in front of anything")],
    },
    created: [],
  };
}

function checkRepoName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw `"${name}" is not a valid repository name: use letters, digits, '-', '_' and '.'`;
  }
}

export function repoAdd(c: FakeCharts, name: string, url: string): string {
  checkRepoName(name);
  if (!/^https?:\/\/\S+$/.test(url)) throw `"${url}" is not a repository URL: it must start with http:// or https://`;
  if (c.repos.some((r) => r.name === name)) {
    throw `Cannot add repository ${name}: repository name (${name}) already exists, please specify a different name`;
  }
  if (!c.servers[url]) {
    throw `Cannot add repository ${name}: looks like "${url}" is not a valid chart repository or cannot be reached: Get "${url}/index.yaml": dial tcp: no such host`;
  }
  c.repos.push({ name, url });
  return `Added repository ${name} (${url})`;
}

export function repoRemove(c: FakeCharts, name: string): string {
  checkRepoName(name);
  if (!c.repos.some((r) => r.name === name)) throw `Cannot remove repository ${name}: no repo named "${name}" found`;
  c.repos = c.repos.filter((r) => r.name !== name);
  return `Removed repository ${name}`;
}

export function repoUpdate(c: FakeCharts, names: string[]): HelmRepoUpdate {
  if (c.repos.length === 0) throw "No chart repositories are configured: add one first.";
  const picked = names.length ? c.repos.filter((r) => names.includes(r.name)) : c.repos;
  const updated: string[] = [];
  const failed: string[] = [];
  for (const r of picked) {
    if (c.servers[r.url]) updated.push(r.name);
    else failed.push(`Repository ${r.name} could not be reached: Get "${r.url}/index.yaml": dial tcp: no such host`);
  }
  return { updated, failed };
}

/** Every chart version in the configured repositories (those whose server is up). */
function allVersions(c: FakeCharts): (FakeChart & { full: string })[] {
  return c.repos.flatMap((r) => (c.servers[r.url] ?? []).map((ch) => ({ ...ch, full: `${r.name}/${ch.name}` })));
}

const listed = (ch: FakeChart & { full: string }): HelmChartVersion => ({
  name: ch.full,
  version: ch.version,
  app_version: ch.app_version,
  description: ch.description,
});

export function search(c: FakeCharts, query: string, versions: boolean): HelmChartVersion[] {
  if (c.repos.length === 0) throw "No chart repositories are configured: add one first.";
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  return allVersions(c)
    .filter((ch) => !q || `${ch.full} ${ch.description}`.toLowerCase().includes(q))
    .filter((ch) => {
      if (versions) return true;
      if (seen.has(ch.full)) return false;
      seen.add(ch.full);
      return true;
    })
    .map(listed);
}

export function chartVersions(c: FakeCharts, name: string): HelmChartVersion[] {
  const all = search(c, "", true);
  return all.filter((v) => (name.includes("/") ? v.name === name : v.name.split("/")[1] === name));
}

function find(c: FakeCharts, name: string, version: string) {
  const all = allVersions(c).filter((ch) => ch.full === name);
  const found = version ? all.find((ch) => ch.version === version) : all[0];
  if (!found) {
    throw `Cannot show chart ${name}: chart "${name.split("/")[1]}" matching ${version} not found in ${name.split("/")[0]} index. (try 'helm repo update')`;
  }
  return found;
}

export function show(c: FakeCharts, name: string, version: string): HelmChartDetails {
  const ch = find(c, name, version);
  return {
    chart: name,
    version: ch.version,
    app_version: ch.app_version,
    description: ch.description,
    home: "https://example.com",
    readme: ch.readme,
    values: ch.values,
  };
}

/** `greeting: <x>` from the values, as the fake charts render it. */
function greetingOf(values: string): string {
  return /^greeting:\s*(\S+)/m.exec(values)?.[1] ?? "hello";
}

/** Values the user supplied: the text minus comment-only lines; empty for none. */
function userValues(values: string): string {
  const kept = values
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join("\n");
  return kept ? `${kept}\n` : "";
}

/** The objects of a fake manifest as `Kind name` -> document without comments. */
function objects(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const doc of text.split(/^---$/m)) {
    const kind = /^kind: (\S+)/m.exec(doc)?.[1];
    const name = /^ {2}name: (\S+)/m.exec(doc)?.[1];
    if (!kind || !name) continue;
    out.set(`${kind} ${name}`, doc.replace(/^#.*\n/gm, "").trim());
  }
  return out;
}

/** Like `dry_run_summary` in `src/helm/deploy.rs`, for the fake charts. */
function drySummary(previous: string, next: string): string {
  const before = objects(previous);
  const after = objects(next);
  const n = after.size;
  const end = ". Nothing has been applied yet";
  if (before.size === 0) return `Dry run: ${n} objects would be created${end}`;
  const changed = [...after].filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => k);
  if (changed.length === 0) return `Dry run: none of the ${n} objects would change${end}`;
  return `Dry run: ${changed.length} of ${n} objects would change (${changed.join(", ")})${end}`;
}

export function deploy(
  h: FakeHelm,
  namespaces: string[],
  mode: "install" | "upgrade",
  req: HelmDeployRequest,
): HelmDeployResult {
  const c = h.charts;
  const verb = req.dry_run ? `Dry run of the ${mode}` : mode === "install" ? "Install" : "Upgrade";
  if (/^\s*[-[]/.test(req.values)) throw "The values must be a YAML mapping (key: value), not a single value or a list";
  if (/:\s*\[\s*$/m.test(req.values)) throw "The values are not valid YAML: did not find expected node content";
  const ch = find(c, req.chart, req.version);
  // Helm sees only the releases in the storage it is told to use.
  const existing = storedIn(h, req.namespace, req.name, req.storage);
  const current = Math.max(0, ...existing.map((r) => r.revision));
  if (mode === "install" && current > 0) throw `${verb} of ${req.name} failed: cannot re-use a name that is still in use`;
  if (mode === "upgrade" && current === 0) {
    throw `${verb} of ${req.name} failed: ${notFound(req.namespace, req.name, req.storage)}`;
  }
  const nsExists = namespaces.includes(req.namespace) || c.created.includes(req.namespace);
  if (mode === "install" && !nsExists && !req.create_namespace) {
    throw `${verb} of ${req.name} failed: create: failed to create: namespaces "${req.namespace}" not found`;
  }
  const greeting = greetingOf(req.values);
  const rev = revision(req.namespace, req.name, current + 1, "deployed", greeting, ch.name);
  rev.chart_version = ch.version;
  rev.app_version = ch.app_version;
  rev.values = userValues(req.values);
  rev.description = mode === "install" ? "Install complete" : "Upgrade complete";
  rev.storage = req.storage;
  const what = `${req.namespace}/${req.name}`;
  const next = manifest(req.name, greeting, req.reveal ? "s3cret" : HIDDEN);
  const latest = existing.find((r) => r.revision === current);
  const previous =
    mode === "upgrade" && req.dry_run && latest
      ? req.reveal
        ? (h.revealed[`${what}@${current}`] ?? latest.manifest)
        : latest.manifest
      : "";
  const result: HelmDeployResult = {
    name: req.name,
    namespace: req.namespace,
    revision: rev.revision,
    status: req.dry_run ? `pending-${mode}` : "deployed",
    chart: ch.name,
    chart_version: ch.version,
    app_version: ch.app_version,
    notes: rev.notes,
    manifest: next,
    previous_manifest: previous,
    secrets_hidden: !req.reveal,
    resources: rev.resources,
    dry_run: req.dry_run,
    summary: req.dry_run
      ? drySummary(previous, next)
      : mode === "install"
        ? `Installed ${what} (revision 1)`
        : `Upgraded ${what} to revision ${rev.revision}`,
  };
  if (req.dry_run) return result;
  if (!nsExists) c.created.push(req.namespace);
  for (const r of existing) if (r.status === "deployed") r.status = "superseded";
  h.revisions.push(rev);
  h.revealed[`${what}@${rev.revision}`] = manifest(req.name, greeting, "s3cret");
  return result;
}
