// Shared set-up for the QA scenarios in qa/: one app per `describe`, a
// screenshot and the page text after every test, the app closed at the end.

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
