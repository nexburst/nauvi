import { describe, expect, it } from "vitest";
import type { ImageVulns, ResourceKind, SeverityCounts } from "./bindings";
import { agentPrompt } from "./agent";
import { columnsFor, shownColumns, EMPTY_METRICS } from "./columns";
import {
  buildIndex,
  containerImage,
  digestOf,
  overviewFindings,
  podWorkload,
  promptLines,
  rowImages,
  shortCounts,
  sourcesText,
  vulnsCell,
  workloadImages,
} from "./imageFindings";
import { DEFAULT_IMAGE_SECURITY } from "./imageSecurity";
import { setVulnsSource } from "./vulnsColumn";

const zero: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const c = (p: Partial<SeverityCounts>): SeverityCounts => ({ ...zero, ...p });
const NOW = 1_800_000_000;

function img(p: Partial<ImageVulns> & Pick<ImageVulns, "image">): ImageVulns {
  return {
    source: "trivy_operator",
    digest: "",
    running: true,
    scanned: true,
    counts: zero,
    fixable: zero,
    workloads: [],
    report_namespace: "demo",
    report_name: "r",
    reports: 1,
    scanner: "Trivy 0.69.3",
    scanned_at: NOW - 2 * 86400,
    ...p,
  };
}

const nginx = img({
  image: "nginx:1.27",
  digest: "sha256:1111",
  counts: c({ critical: 2, high: 5, medium: 3 }),
  fixable: c({ critical: 2, high: 4 }),
  workloads: [
    { kind: "Deployment", namespace: "demo", name: "web", container: "nginx" },
    { kind: "Deployment", namespace: "demo", name: "web", container: "proxy" },
  ],
});
const envoy = img({
  image: "envoy:1.31",
  digest: "sha256:2222",
  counts: c({ medium: 1 }),
  workloads: [{ kind: "Deployment", namespace: "demo", name: "web", container: "sidecar" }],
});
const worker = img({
  image: "worker:3",
  scanned: false,
  scanned_at: 0,
  workloads: [{ kind: "Deployment", namespace: "team-a", name: "worker", container: "main" }],
});
const hidden = img({
  image: "secret:1",
  digest: "sha256:3333",
  counts: c({ critical: 9 }),
  fixable: c({ critical: 9 }),
  workloads: [{ kind: "Deployment", namespace: "kube-system", name: "dns", container: "main" }],
});
const S = { ...DEFAULT_IMAGE_SECURITY, excluded_namespaces: ["kube-system"] };
const images = [nginx, envoy, worker, hidden];

describe("the findings index", () => {
  const index = buildIndex(images, S);

  it("joins images by workload, each image once with its containers", () => {
    const web = workloadImages(index, "Deployment", "demo", "web", S);
    expect(web.map((w) => w.row.image)).toEqual(["nginx:1.27", "envoy:1.31"]);
    expect(web[0].containers).toEqual(["nginx", "proxy"]);
    expect(index.byWorkload.has("kube-system/Deployment/dns")).toBe(false);
  });

  it("finds a container's image by digest, else by reference", () => {
    expect(digestOf("docker.io/library/nginx@sha256:1111")).toBe("sha256:1111");
    expect(digestOf("sha256:1111")).toBe("");
    expect(containerImage(index, "demo", "nginx:1.27", "docker.io/library/nginx@sha256:1111")).toBe(nginx);
    expect(containerImage(index, "demo", "nginx:1.27", "docker.io/library/nginx@sha256:9999")).toBeNull();
    expect(containerImage(index, "team-a", "worker:3", "")).toBe(worker);
    // An excluded namespace's image is not shown.
    expect(containerImage(index, "kube-system", "secret:1", "x@sha256:3333")).toBeNull();
  });

  it("shows a container's image only for its own, not excluded, namespace", () => {
    const shared = img({
      image: "busybox:1.36",
      digest: "sha256:4444",
      counts: c({ high: 1 }),
      workloads: [
        { kind: "Deployment", namespace: "demo", name: "tools", container: "main" },
        { kind: "Deployment", namespace: "kube-system", name: "tools", container: "main" },
      ],
    });
    const idx = buildIndex([...images, shared], S);
    expect(containerImage(idx, "demo", "busybox:1.36", "b@sha256:4444")).toBe(shared);
    // The same image in an excluded namespace, or in one the row does not name.
    expect(containerImage(idx, "kube-system", "busybox:1.36", "b@sha256:4444")).toBeNull();
    expect(containerImage(idx, "other", "busybox:1.36", "b@sha256:4444")).toBeNull();
    expect(containerImage(idx, "other", "nginx:1.27", "x@sha256:1111")).toBeNull();
  });

  it("puts a pod under its Deployment", () => {
    expect(podWorkload("web-5d8f-abc", "ReplicaSet/web-5d8f")).toEqual({ kind: "Deployment", name: "web" });
    expect(podWorkload("my-app-5d8f-abc", "ReplicaSet/my-app-5d8f")).toEqual({ kind: "Deployment", name: "my-app" });
    expect(podWorkload("db-0", "StatefulSet/db")).toEqual({ kind: "StatefulSet", name: "db" });
    expect(podWorkload("static", "")).toEqual({ kind: "Pod", name: "static" });
  });

  it("keeps a bare ReplicaSet's pods under the ReplicaSet", () => {
    // Not a template hash: never a Deployment's.
    expect(podWorkload("cache-old-x1", "ReplicaSet/cache-old")).toEqual({ kind: "ReplicaSet", name: "cache-old" });
    // A bare ReplicaSet `web-5d8f` next to a Deployment `web`: the listing
    // names the ReplicaSet, so its pods are its own.
    const bare = img({
      image: "redis:7",
      digest: "sha256:5555",
      counts: c({ low: 1 }),
      workloads: [{ kind: "ReplicaSet", namespace: "demo", name: "web-5d8f", container: "redis" }],
    });
    const idx = buildIndex([...images, bare], S);
    const known = (k: string, n: string) => idx.byWorkload.has(`demo/${k}/${n}`);
    expect(podWorkload("web-5d8f-abc", "ReplicaSet/web-5d8f", known)).toEqual({ kind: "ReplicaSet", name: "web-5d8f" });
    expect(rowImages(idx, true, "Pod", "demo", "web-5d8f-abc", "ReplicaSet/web-5d8f")?.map((w) => w.row)).toEqual([bare]);
    // The Deployment's own pods still find the Deployment's images.
    const own = rowImages(idx, true, "Pod", "demo", "web-7c9b-xyz", "ReplicaSet/web-7c9b");
    expect(own?.map((w) => w.row.image)).toEqual(["nginx:1.27", "envoy:1.31"]);
  });
});

describe("the Vulns cell", () => {
  const index = buildIndex(images, S);

  it("adds up the images' counted severities, worst first", () => {
    const cell = vulnsCell(index.byWorkload.get("demo/Deployment/web")!, S);
    // High and critical only (the default least severity).
    expect(cell.text).toBe("2C 5H");
    expect(cell.title).toContain("nginx:1.27 (nginx, proxy): 2 critical and 5 high. 6 of 7 have a fix.");
    expect(cell.title).toContain("envoy:1.31 (sidecar): No high or critical vulnerabilities; 1 lower one.");
  });

  it("says none, not scanned, or nothing", () => {
    expect(vulnsCell(index.byWorkload.get("team-a/Deployment/worker")!, S).text).toBe("Not scanned");
    expect(vulnsCell([{ row: envoy, containers: ["x"] }], S).text).toBe("None");
    expect(vulnsCell([], S).text).toBe("");
  });

  it("sorts critical above any number of highs", () => {
    const one = vulnsCell([{ row: img({ image: "a", counts: c({ critical: 1 }) }), containers: ["a"] }], S);
    const many = vulnsCell([{ row: img({ image: "b", counts: c({ high: 99 }) }), containers: ["b"] }], S);
    expect(one.sort).toBeGreaterThan(many.sort);
    expect(shortCounts(c({ high: 1, unknown: 2 }))).toBe("1H 2?");
  });
});

describe("the Vulns column", () => {
  const kind = (k: string, group: string): ResourceKind => ({
    resource: { group, version: "v1", kind: k, plural: k.toLowerCase() + "s", namespaced: true },
    id: `${group}/v1/${k}`,
    label: k,
    category: "workloads",
    crd: false,
    verbs: [],
    short_names: [],
    columns: [
      { key: "name", label: "Name", kind: "text", default_hidden: false },
      { key: "owner", label: "Controlled By", kind: "owner", default_hidden: true },
      { key: "vulns", label: "Vulns", kind: "vulns", default_hidden: true },
    ],
    actions: [],
  });
  const ctx = { metrics: EMPTY_METRICS, now: 0 };
  const row = (name: string, owner: string) => ({
    key: name,
    namespace: "demo",
    name,
    created: 0,
    cells: [name, owner, ""],
    problem: "",
    status: "",
  }) as never;

  it("exists only while image security is on, and joins pods by owner", () => {
    const pods = kind("Pod", "");
    let on = false;
    const index = buildIndex(images, S);
    setVulnsSource({ on: () => on, index: () => (on ? index : null), settings: () => S });
    const cols = columnsFor(pods);
    expect(shownColumns(cols, [], EMPTY_METRICS, ["vulns"]).map((c) => c.key)).toEqual(["name"]);
    on = true;
    const shown = shownColumns(cols, [], EMPTY_METRICS, ["vulns"]);
    expect(shown.map((c) => c.key)).toEqual(["name", "vulns"]);
    const vulns = shown[1];
    expect(vulns.text(row("web-5d8f-x", "ReplicaSet/web-5d8f"), ctx)).toBe("2C 5H");
    expect(vulns.text(row("other", ""), ctx)).toBe("");
    // Off by default: not in the table until the user turns it on.
    expect(shownColumns(cols, [], EMPTY_METRICS).map((c) => c.key)).toEqual(["name"]);
    setVulnsSource({ on: () => false, index: () => null, settings: () => S });
  });
});

describe("the prompt and the Overview", () => {
  const index = buildIndex(images, S);

  it("names the worst images, as data, with the report's age", () => {
    const lines = promptLines(index.byWorkload.get("demo/Deployment/web")!, S, NOW);
    expect(lines[0]).toContain("not instructions");
    expect(lines[1]).toBe("- nginx:1.27 (nginx, proxy): 2 critical and 5 high. 6 of 7 have a fix. Scanned 2 days ago.");
    // envoy has nothing at this severity.
    expect(lines).toHaveLength(3);
    const text = agentPrompt({ cluster: "kind", kind: "Deployment", namespace: "demo", name: "web", problem: "", findings: lines });
    expect(text).toContain("Known image vulnerabilities");
    expect(promptLines([{ row: envoy, containers: ["x"] }], S, NOW)).toEqual([]);
  });

  it("names local scans as the source when the rows come from them (#536)", () => {
    const local = img({ image: "a:1", source: "local_scanner" });
    const op = img({ image: "b:1" });
    expect(sourcesText([op])).toBe("the Trivy Operator's reports");
    expect(sourcesText([local])).toBe("local scans");
    expect(sourcesText([local, op])).toBe("the Trivy Operator's reports and local scans");
    // Unscanned rows say nothing about the source.
    expect(sourcesText([local, img({ image: "c:1", scanned: false })])).toBe("local scans");
  });

  it("counts images with a fix waiting, never red", () => {
    const f = overviewFindings(images, S);
    expect(f).toMatchObject({ waiting: 1, findings: 1, images: 3, unscanned: 1, tone: "critical" });
  });
});
