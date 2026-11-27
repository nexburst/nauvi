// Available tags (#539): newer tags of a running image from its registry.
//
// A local HTTPS registry (its own test CA, through the debug-only
// NAUVI_REGISTRY_TEST_CA) speaks the OCI distribution API with the
// anonymous token flow and `Link` pages, and stands in for Docker Hub
// (NAUVI_REGISTRY_TEST_DOCKER_HUB) and its tag-date API: nothing reaches the
// real Docker Hub. The pods run busybox:1.36 and 1.37 (loaded in the kind
// nodes, so they really run and have an imageID); the registry says 1.36 was
// pushed again (another digest) and 1.37 was not. A second pod names a
// private repository on the same registry, which needs the login in a docker
// config of the profile's own (DOCKER_CONFIG), and an image on a port where
// nothing listens.
// Checks: off by default (no button, no request); the setting in Settings;
// nothing asked before the click; grouping newer minor / major with the
// variant kept; the repushed tag; the cache; the private registry's token
// asked with the docker credentials, which go nowhere else; a plain error
// for a registry it cannot reach; the workload panel; light and dark theme.
// Needs openssl (for the test certificates); skipped without it.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { panelText, scrollPanelTo, setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 180_000 };
const SKIP = spawnSync("openssl", ["version"]).status === 0 ? false : "needs openssl for the test certificates";

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-539-"));
const dockerDir = join(dir, "docker");
const REPUSHED = `sha256:${"f".repeat(64)}`;
const USER = "qa-user";
const PASSWORD = "qa-539-secret";
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/** What the registry was asked: path, and whether it carried credentials. */
const served = { requests: [], running137: "" };
let server;
let authority;

const HUB_PAGES = [
  ["1.35", "1.36", "1.36.0", "1.36.1", "musl"],
  ["1.37", "1.37.0", "1.38", "2.0", "latest", "1.37-musl", "1.36-uclibc"],
];
const PRIVATE_TAGS = ["7.0.1-jammy", "7.0.2-jammy", "7.0.3-jammy", "7.1.0-jammy", "8.0.0-jammy", "7.0.2-alpine", "jammy"];

function makeCerts() {
  const ossl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
    "-subj", "/CN=nauvi QA 539 CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1");
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  ossl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem",
    "-days", "2", "-extfile", "ext.cnf");
}

function handle(req, res) {
  const url = new URL(req.url, `https://${authority}`);
  served.requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization ?? "" });
  const json = (status, body, headers = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  const challenge = { "www-authenticate": `Bearer realm="https://${authority}/token",service="qa-registry"` };

  if (url.pathname === "/token") {
    const scope = url.searchParams.get("scope") ?? "";
    if (scope === "repository:qa/private:pull") {
      if (req.headers.authorization !== BASIC) return json(401, { errors: [{ code: "UNAUTHORIZED" }] });
      return json(200, { token: "token-private" });
    }
    return json(200, { token: `token-${scope.split(":")[1]?.replaceAll("/", "-")}` });
  }
  if (url.pathname.startsWith("/v2/namespaces/library/repositories/busybox/tags")) {
    return json(200, {
      next: null,
      results: [
        { name: "2.0", last_updated: "2026-11-02T08:00:00.000000Z" },
        { name: "1.38", last_updated: "2026-10-12T08:00:00.000000Z" },
        { name: "1.37", last_updated: "2026-06-01T08:00:00.000000Z" },
      ],
    });
  }
  const m = url.pathname.match(/^\/v2\/(library\/busybox|qa\/private)\/(tags\/list|manifests\/([^/]+))$/);
  if (!m) return json(404, { errors: [{ code: "NAME_UNKNOWN" }] });
  const repo = m[1];
  const want = repo === "qa/private" ? "Bearer token-private" : "Bearer token-library-busybox";
  if (req.headers.authorization !== want) return json(401, { errors: [{ code: "UNAUTHORIZED" }] }, challenge);
  if (m[2] === "tags/list") {
    if (repo === "qa/private") return json(200, { name: repo, tags: PRIVATE_TAGS });
    const page = url.searchParams.get("last") ? 1 : 0;
    const link = page === 0 ? { link: `</v2/${repo}/tags/list?last=musl&n=5>; rel="next"` } : {};
    return json(200, { name: repo, tags: HUB_PAGES[page] }, link);
  }
  const tag = m[3];
  const digest = repo === "library/busybox" && tag === "1.36" ? REPUSHED : tag === "1.37" ? served.running137 : "";
  if (!digest) return res.writeHead(404).end();
  res.writeHead(200, { "docker-content-digest": digest, "content-type": "application/vnd.oci.image.index.v1+json" }).end();
}

async function startServer() {
  makeCerts();
  server = createServer({ key: readFileSync(join(dir, "server.key")), cert: readFileSync(join(dir, "server.pem")) }, handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  authority = `127.0.0.1:${server.address().port}`;
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(
    join(dockerDir, "config.json"),
    JSON.stringify({ auths: { [authority]: { auth: Buffer.from(`${USER}:${PASSWORD}`).toString("base64") } } }),
  );
}

const fixtures = (registry) => `
apiVersion: v1
kind: Pod
metadata:
  name: qa-tags
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: old
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
    - name: current
      image: busybox:1.37
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
---
apiVersion: v1
kind: Pod
metadata:
  name: qa-private
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: ${registry}/qa/private:7.0.1-jammy
    - name: nowhere
      image: 127.0.0.1:1/qa/gone:1.0
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-deploy
spec:
  replicas: 1
  selector: { matchLabels: { app: qa-deploy } }
  template:
    metadata: { labels: { app: qa-deploy } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: web
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sleep", "3600"]
`;

const profile = createProfile();
let ns;

/** The text of the Available tags box of `container` (in the open panel). */
const boxText = (app, container) =>
  app.js(
    `return document.querySelector('[data-testid="detail-panel"] [role="region"][aria-label="Available tags of ' + arguments[0] + '"]')?.innerText ?? ""`,
    container,
  );

async function clickTags(app, container) {
  const b = await app.find(By.css(`[data-testid="detail-panel"] button[aria-label="Available tags of ${container}"]`));
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", b);
  await b.click();
}

/** Wait until the box of `container` has an answer (not "Asking…"). */
const answer = (app, container) =>
  app.waitFor(
    async () => {
      const t = await boxText(app, container);
      return t && !t.startsWith("Asking") ? t : null;
    },
    { timeout: 60_000, message: `the available tags of ${container}` },
  );

const registryRequests = () => served.requests.filter((r) => r.path.startsWith("/v2/") || r.path === "/token");

describe("available tags (#539)", { timeout: 15 * 60_000, skip: SKIP }, () => {
  before(async () => {
    await startServer();
    ns = tempNamespace("qa-tags", fixtures(authority));
    waitPodReady(ns, "qa-tags");
    const ids = JSON.parse(kubectl(["-n", ns, "get", "pod", "qa-tags", "-o", "jsonpath={.status.containerStatuses}"]));
    const id137 = ids.find((c) => c.name === "current")?.imageID ?? "";
    served.running137 = id137.split("@")[1] ?? "";
    console.log(`imageIDs: ${ids.map((c) => `${c.name}=${c.imageID}`).join(" ")}`);
  });
  const s = appSession("registry-tags", async () => ({
    profile,
    env: {
      NAUVI_REGISTRY_TEST_CA: join(dir, "ca.pem"),
      NAUVI_REGISTRY_TEST_DOCKER_HUB: authority,
      DOCKER_CONFIG: dockerDir,
    },
  }));
  after(() => {
    server?.close();
    deleteNamespace(ns);
    rmSync(dir, { recursive: true, force: true });
    profile.remove();
  });

  it("shows no button and asks nothing while the setting is off", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "qa-tags");
    await app.waitFor(async () => (await panelText(app)).includes("busybox:1.37"), { message: "the containers" });
    assert.equal(await app.js(`return document.querySelectorAll('[data-testid="available-tags"]').length`), 0);
    assert.deepEqual(served.requests, []);
  });

  it("turns it on in Settings", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
    await app.find(byTestId("settings"));
    await app.js(
      `Array.from(document.querySelectorAll('[data-testid="settings"] [role="tab"]')).find((t) => t.textContent.trim() === "Clusters")?.click()`,
    );
    const box = await app.find(By.css('[data-testid="registry-tags-settings"] input[type="checkbox"]'));
    await app.js(`document.querySelector('[data-testid="registry-tags-settings"]').scrollIntoView({ block: "center" })`);
    assert.equal(await box.isSelected(), false);
    await box.click();
    await app.waitFor(async () => profile.settings()?.registry_tags === true, { message: "registry_tags saved" });
  });

  it("asks nothing before the click, then groups the newer tags and says the tag was pushed again", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
    await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Available tags of old"]'));
    assert.deepEqual(served.requests, [], "nothing is asked before the click");
    await clickTags(app, "old");
    const text = await answer(app, "old");
    console.log(`old: ${JSON.stringify(text)}`);
    assert.match(text, /This tag was updated in the registry: 1\.36 now points to sha256:ffffffffffff/);
    assert.match(text, /Newer minor · new features\n?1\.38\s*2026-10-12\s*1\.37\s*2026-06-01/);
    assert.match(text, /Newer major · may break things\n?2\.0\s*2026-11-02/);
    assert.match(text, /Not versions\n?latest\s+musl/);
    assert.ok(!/1\.37-musl|1\.36\.1|1\.36-uclibc/.test(text), "only tags with the same shape and variant");
    assert.match(text, /12 tags on Docker Hub/);
    const pages = registryRequests().filter((r) => r.path === "/v2/library/busybox/tags/list" && r.auth);
    assert.equal(pages.length, 2, "both Link pages read");
    assert.ok(
      registryRequests().every((r) => r.auth !== BASIC),
      "the private registry's credentials are not sent for the Docker Hub stand-in",
    );
    await scrollPanelTo(app, '[data-testid="available-tags"]');
  });

  it("says a tag that was not pushed again still points to what runs, and caches the list", T, async () => {
    const { app } = s;
    assert.ok(served.running137, "the pod reports an imageID for busybox:1.37");
    const before = registryRequests().filter((r) => r.path.endsWith("/tags/list")).length;
    await clickTags(app, "current");
    const text = await answer(app, "current");
    assert.match(text, /1\.37 still points to what the container runs/);
    assert.match(text, /Newer minor · new features\n?1\.38/);
    // Another tag of the same repository is a new look-up; the same image
    // again comes from the cache.
    const after1 = registryRequests().filter((r) => r.path.endsWith("/tags/list")).length;
    assert.ok(after1 > before);
    await (await app.find(By.xpath("//*[@aria-label='Available tags of current']//button[normalize-space()='Hide']"))).click();
    await clickTags(app, "current");
    await answer(app, "current");
    assert.equal(registryRequests().filter((r) => r.path.endsWith("/tags/list")).length, after1, "served from the cache");
    await scrollPanelTo(app, '[aria-label="Available tags of current"]');
  });

  it("logs in to a private registry with the docker config, keeping the variant", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "qa-private");
    await clickTags(app, "app");
    const text = await answer(app, "app");
    console.log(`private: ${JSON.stringify(text)}`);
    assert.match(text, /Newer patch · safe to update\n?7\.0\.3-jammy\s+7\.0\.2-jammy/);
    assert.match(text, /Newer minor · new features\n?7\.1\.0-jammy/);
    assert.match(text, /Newer major · may break things\n?8\.0\.0-jammy/);
    assert.ok(!text.includes("7.0.2-alpine"));
    const token = served.requests.find((r) => r.path === "/token" && r.query.includes("qa%2Fprivate"));
    assert.equal(token?.auth, BASIC, "the token was asked with the docker credentials");
  });

  it("says plainly when a registry cannot be reached", T, async () => {
    const { app } = s;
    await clickTags(app, "nowhere");
    const text = await answer(app, "nowhere");
    console.log(`nowhere: ${JSON.stringify(text)}`);
    assert.match(text, /Cannot reach 127\.0\.0\.1:1/);
    assert.match(text, /Try again/);
    await scrollPanelTo(app, '[aria-label="Available tags of nowhere"]');
  });

  it("lists a workload's images with the button", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-deploy");
    await app.waitFor(async () => (await panelText(app)).includes("Images"), { message: "the Images section" });
    await clickTags(app, "web");
    const text = await answer(app, "web");
    assert.match(text, /Newer minor · new features\n?1\.38/);
    assert.ok(!text.includes("was updated in the registry"), "no running imageID in a workload panel");
    await scrollPanelTo(app, '[data-testid="workload-images"]');
  });

  it("reads in the dark theme", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await app.openDetail("Pods", ns, "qa-tags");
    await clickTags(app, "old");
    await answer(app, "old");
    await scrollPanelTo(app, '[data-testid="available-tags"]');
  });
});
