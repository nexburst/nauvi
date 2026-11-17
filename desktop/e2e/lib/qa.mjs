// Shared set-up for the QA scenarios in qa/: one app per `describe`, a
// screenshot and the page text after every test, the app closed at the end.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before } from "node:test";
import { launch } from "./app.mjs";

/**
 * Launch the app before the suite's tests (`opts` as for `launch`, or a
 * function returning them, run in `before`) and close it after them.
 * Returns an object whose `app` is set once launched.
 *
 *   const s = appSession("terminal");
 *   it("...", async () => { await s.app.nav("Pods"); });
 */
export function appSession(name, opts = {}) {
  const session = { app: null };
  before(async () => {
    session.app = await launch(name, typeof opts === "function" ? await opts() : opts);
  });
  afterEach(async (t) => {
    await session.app?.shot(t.name);
  });
  after(async () => {
    await session.app?.close();
  });
  return session;
}

/** Wait for the header status to say "Live". */
export function waitLive(app, timeout = 60_000) {
  return app.waitFor(async () => (await app.statusText()) === "Live", { timeout, message: 'header status "Live"' });
}

/**
 * A kubeconfig whose only context, `qa-unreachable`, points at a closed
 * local port: for scenarios that need no cluster (startup, Windows).
 */
export function unreachableKubeconfig() {
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-kc-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters:
  - name: nowhere
    cluster:
      server: https://127.0.0.1:1
contexts:
  - name: qa-unreachable
    context:
      cluster: nowhere
      user: nobody
current-context: qa-unreachable
users:
  - name: nobody
    user:
      token: not-a-token
`,
  );
  return path;
}
