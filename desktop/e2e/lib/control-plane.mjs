// Pause a kind control plane (`docker pause`) to test reconnecting, and
// make sure it is unpaused again whatever happens: the cluster is shared
// with other runs.
//
// Guards, from the inside out: `finally`; a timer that unpauses after
// `maxMs`; process exit and signal handlers; and a marker file in
// $QA_RUN_DIR that qa.sh's exit trap unpauses from.

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT } from "./app.mjs";

const paused = new Set();

function unpauseSync(container) {
  try {
    execFileSync("docker", ["unpause", container], { stdio: "ignore", timeout: 30_000 });
  } catch {
    /* not paused */
  }
  paused.delete(container);
  if (process.env.QA_RUN_DIR) rmSync(join(process.env.QA_RUN_DIR, `paused-${container}`), { force: true });
}

function unpauseAll() {
  for (const c of [...paused]) unpauseSync(c);
}

let installed = false;
function installGuards() {
  if (installed) return;
  installed = true;
  process.once("exit", unpauseAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      unpauseAll();
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
    });
  }
}

/** The kind control-plane container of a `kind-<name>` context. */
export function controlPlaneContainer(context = CONTEXT) {
  if (!context.startsWith("kind-")) throw new Error(`${context} is not a kind context`);
  return `${context.slice("kind-".length)}-control-plane`;
}

/**
 * Why the control plane of `context` can't be paused from here (not kind,
 * no docker access), or "" if it can. For a test's `skip`.
 */
export function cannotPause(context = CONTEXT) {
  if (process.env.QA_NO_PAUSE) return "QA_NO_PAUSE is set";
  let container;
  try {
    container = controlPlaneContainer(context);
  } catch (e) {
    return e.message;
  }
  try {
    execFileSync("docker", ["inspect", "-f", "{{.State.Status}}", container], { stdio: "pipe", timeout: 10_000 });
    return "";
  } catch (e) {
    const why = String(e.stderr ?? e.message).trim().split("\n")[0];
    return `cannot use docker on ${container}: ${why}`;
  }
}

/** Wait until the API server answers again (after an unpause). */
export async function waitForApiServer(context = CONTEXT, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      execFileSync("kubectl", ["--context", context, "get", "--raw", "/readyz"], { stdio: "ignore", timeout: 10_000 });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the API server of ${context} is not ready: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Run `fn` with the control plane paused, then unpause it and wait for the
 * API server. The pause never outlasts `maxMs` (default 60 s), even if `fn`
 * hangs: other agents and tests use the same cluster.
 */
export async function withControlPlanePaused(fn, { context = CONTEXT, maxMs = 60_000 } = {}) {
  const container = controlPlaneContainer(context);
  installGuards();
  if (process.env.QA_RUN_DIR) writeFileSync(join(process.env.QA_RUN_DIR, `paused-${container}`), container);
  paused.add(container);
  const timer = setTimeout(() => {
    console.error(`control plane paused for ${maxMs} ms: unpausing ${container}`);
    unpauseSync(container);
  }, maxMs);
  try {
    execFileSync("docker", ["pause", container], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
    return await fn();
  } finally {
    clearTimeout(timer);
    unpauseSync(container);
    await waitForApiServer(context);
  }
}
