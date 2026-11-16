// #202: a second launch focuses the running app and exits, instead of
// starting a second copy that reopens the same windows and overwrites
// settings.json.
// - the second launch (same settings, another kubeconfig) exits with 0 within
//   seconds; still one process, one window, the same title, settings.json
//   unchanged, and the running app logs that it came to the front
// - a launch with other settings (another HOME) is a separate app and starts
//
// On Linux the plugin finds the running app on the D-Bus session bus. The
// scenario starts a private bus, so it never talks to the developer's own
// session or another agent's run (CI has no session bus at all).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { ARTIFACTS, CONTEXT, REPO } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, unreachableKubeconfig, waitLive } from "../lib/qa.mjs";
import { x11Titles, x11Windows } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const NAME = "single-instance";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cannotRun() {
  if (process.platform !== "linux") return "the D-Bus check is Linux-only (Windows and macOS: by hand)";
  if (!process.env.DISPLAY) return "no $DISPLAY";
  for (const tool of ["dbus-daemon", "xwininfo", "xprop"]) {
    try {
      execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    } catch {
      return `no ${tool}`;
    }
  }
  return false;
}

function appBinary() {
  if (process.env.KUBELOUPE_APP) return resolve(process.env.KUBELOUPE_APP);
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(REPO, "target");
  return join(target, "debug", "kubeloupe-desktop");
}

/**
 * A private session bus with no activatable services (no portals or
 * accessibility bus get started on it); resolves to { address, stop }.
 */
function startBus() {
  const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-bus-"));
  const config = join(dir, "session.conf");
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${dir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const proc = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork", "--nopidfile", "--print-address=1"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stop = () => {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };
  return new Promise((ok, fail) => {
    let out = "";
    proc.once("error", fail);
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) ok({ address: out.split("\n")[0].trim(), stop });
    });
    setTimeout(() => fail(new Error("dbus-daemon printed no address")), 10_000);
  });
}

/** PIDs of kubeloupe-desktop processes whose HOME is `home`. */
function appPids(home) {
  const out = execFileSync("sh", ["-c", "pgrep -f kubeloupe-desktop || true"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((pid) => {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        return comm.startsWith("kubeloupe-desk") && readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HOME=${home}`);
      } catch {
        return false;
      }
    });
}

/** Run the app binary directly, like a second click on its icon. */
function launchDirect(env) {
  const proc = spawn(appBinary(), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const exited = new Promise((ok) => proc.once("exit", (code, signal) => ok({ code, signal })));
  return { proc, exited, output: () => output };
}

function timeout(ms) {
  return sleep(ms).then(() => "still running");
}

describe("#202: single instance", { timeout: 10 * 60_000, skip: cannotRun() }, () => {
  let bus;
  const kubeconfigs = [];
  const others = [];
  after(() => {
    for (const o of others) o.proc.kill("SIGKILL");
    others.forEach((o) => o.profile?.remove());
    for (const k of kubeconfigs) rmSync(dirname(k), { recursive: true, force: true });
    bus?.stop();
  });
  const s = appSession(NAME, async () => {
    bus = await startBus();
    return { env: { DBUS_SESSION_BUS_ADDRESS: bus.address } };
  });

  /** The environment a second launch of the same app gets. */
  const secondEnv = (app, extra = {}) => ({
    ...process.env,
    ...app.profile.env(),
    KUBELOUPE_NO_SHELL_ENV: "1",
    DBUS_SESSION_BUS_ADDRESS: bus.address,
    ...extra,
  });

  it("a second launch with another kubeconfig focuses the running app and exits", T, async () => {
    const { app } = s;
    await waitLive(app);
    const pid = appPid(app.profile.home);
    assert.ok(pid, "the first app runs");
    // Let the first app's settings writes land.
    await app.waitFor(() => existsSync(app.profile.settingsPath), { message: "settings.json" }).catch(() => {});
    await sleep(1500);
    const settingsBefore = existsSync(app.profile.settingsPath) ? readFileSync(app.profile.settingsPath, "utf8") : null;
    const titlesBefore = x11Titles(pid);
    assert.equal(titlesBefore.length, 1, `one window before (${titlesBefore.join(", ")})`);

    // Another kubeconfig whose only context is unreachable: the second launch
    // must not open it or switch the running app to it.
    const unreachable = unreachableKubeconfig();
    kubeconfigs.push(unreachable);
    const second = launchDirect(secondEnv(app, { KUBECONFIG: unreachable }));
    const result = await Promise.race([second.exited, timeout(30_000)]);
    if (result === "still running") others.push(second);
    console.log(`second launch: ${JSON.stringify(result)}; output: ${second.output().trim() || "(none)"}`);
    assert.deepEqual(result, { code: 0, signal: null }, "the second launch exits with 0");

    await sleep(1500);
    assert.deepEqual(appPids(app.profile.home), [pid], "still one kubeloupe process");
    assert.equal(x11Windows(pid).length, 1, "still one window");
    assert.deepEqual(x11Titles(pid), titlesBefore, `the window still shows ${CONTEXT}`);
    assert.equal(await app.statusText(), "Live");
    if (settingsBefore !== null) {
      const after = readFileSync(app.profile.settingsPath, "utf8");
      assert.equal(after, settingsBefore, "settings.json unchanged");
      JSON.parse(after);
    }
    const log = readFileSync(join(ARTIFACTS, `${NAME}-app.log`), "utf8");
    assert.match(log, /another launch; bringing the running app to the front/, "the running app got the second launch");
  });

  it("a launch with its own settings (another HOME) is a separate app", T, async () => {
    const { app } = s;
    const profile = createProfile();
    const unreachable = unreachableKubeconfig();
    kubeconfigs.push(unreachable);
    const other = launchDirect({
      ...process.env,
      ...profile.env(),
      KUBELOUPE_NO_SHELL_ENV: "1",
      DBUS_SESSION_BUS_ADDRESS: bus.address,
      KUBECONFIG: unreachable,
    });
    others.push({ ...other, profile });
    const result = await Promise.race([other.exited, timeout(8_000)]);
    assert.equal(result, "still running", `the other app keeps running (${JSON.stringify(result)}: ${other.output()})`);
    await app.waitFor(() => x11Windows(other.proc.pid).length === 1, { message: "the other app's window", timeout: 30_000 });
    // The first app is untouched.
    assert.equal(appPids(app.profile.home).length, 1);
    assert.equal(await app.statusText(), "Live");
    other.proc.kill("SIGKILL");
    await other.exited;
  });
});
