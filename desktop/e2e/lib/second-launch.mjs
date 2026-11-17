// A second launch of the app next to the one under test (#202, #299): a
// private D-Bus session bus for the single-instance plugin, and the app
// binary run directly, as a click on its icon or a nauvi:// link would.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO } from "./app.mjs";

/** Why a second launch can't be checked here, or false. */
export function cannotLaunchTwice() {
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

export function appBinary() {
  if (process.env.NAUVI_APP) return resolve(process.env.NAUVI_APP);
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(REPO, "target");
  return join(target, "debug", "nauvi-desktop");
}

/**
 * A private session bus with no activatable services (no portals or
 * accessibility bus get started on it); resolves to { address, stop }.
 */
export function startBus() {
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-bus-"));
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

/** PIDs of nauvi-desktop processes whose HOME is `home`. */
export function appPids(home) {
  const out = execFileSync("sh", ["-c", "pgrep -f nauvi-desktop || true"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((pid) => {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        return comm.startsWith("nauvi-desk") && readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HOME=${home}`);
      } catch {
        return false;
      }
    });
}

/** Run the app binary directly with `args`, like a second click on its icon or an opened link. */
export function launchDirect(env, args = []) {
  const proc = spawn(appBinary(), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const exited = new Promise((ok) => proc.once("exit", (code, signal) => ok({ code, signal })));
  return { proc, exited, output: () => output };
}
