// TEMPORARY (#353 round 2, not for merge): idle memory of the release build
// under environment variants, one app per variant, on the qa.yml runner.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { measure, topMappings } from "../lib/memory.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (k) => (k / 1024).toFixed(0);

// "" keeps the app from setting a variable (it only sets unset ones) and
// means "not set" to GTK and WebKit.
const OLD = { GDK_GL: "", WEBKIT_WEB_RENDER_DEVICE_FILE: "" };
const VARIANTS = [
  ["main (before)", OLD],
  ["this branch", {}],
  ["GDK_GL only", { WEBKIT_WEB_RENDER_DEVICE_FILE: "" }],
  ["render device only", { GDK_GL: "" }],
  ["branch + skia cpu", { WEBKIT_SKIA_ENABLE_CPU_RENDERING: "1" }],
  ["branch + no compositing", { WEBKIT_DISABLE_COMPOSITING_MODE: "1" }],
  ["branch + MALLOC_ARENA_MAX=2", { MALLOC_ARENA_MAX: "2" }],
  ["main again", OLD],
];

const rows = [];
for (const [label, env] of VARIANTS) {
  describe(`variant ${label}`, { timeout: 4 * 60_000 }, () => {
    const s = appSession(`mem-${label.replace(/\W+/g, "-")}`, { env });
    it(`idle ${label}`, { timeout: 180_000 }, async () => {
      const { app } = s;
      await waitLive(app);
      await app.find(By.css(".overview .card"), { timeout: 60_000 });
      await sleep(30_000);
      const pid = appPid(app.profile.home);
      const samples = [];
      for (let i = 0; i < 3; i++) {
        samples.push(measure(pid));
        if (i < 2) await sleep(1000);
      }
      samples.sort((a, b) => a.coreAndWeb.rss - b.coreAndWeb.rss);
      const r = samples[1];
      const maps = Object.fromEntries(
        [pid, ...r.processes.filter((p) => p.comm.startsWith("WebKitWebProc")).map((p) => p.pid)].map((p) => [
          p,
          topMappings(p, 25),
        ]),
      );
      writeFileSync(join(ARTIFACTS, `mem-${label.replace(/\W+/g, "-")}.json`), JSON.stringify({ label, env, ...r, maps }, null, 2));
      const line = `| ${label} | ${mb(r.core.rss)} / ${mb(r.core.pss)} | ${mb(r.web.rss)} / ${mb(r.web.pss)} | ${mb(r.coreAndWeb.rss)} | ${mb(r.total.pss)} |`;
      rows.push(line);
      console.log(line);
      const md = ["", "| Variant | Core RSS / PSS | Web RSS / PSS | Core+Web RSS | All PSS |", "| --- | ---: | ---: | ---: | ---: |", ...rows, ""].join("\n");
      writeFileSync(join(ARTIFACTS, "mem-variants.md"), md);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    });
  });
}
