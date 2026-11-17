// TEMPORARY for #353 (removed before merge): idle memory of the release
// build under WebKit environment variants, to find what the webview's
// anonymous memory is.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, launch } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { measure, topMappings } from "../lib/memory.mjs";
import { waitLive } from "../lib/qa.mjs";

if (process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP)) {
  process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VARIANTS = {
  baseline: {},
  noCompositing: { WEBKIT_DISABLE_COMPOSITING_MODE: "1" },
  skiaCpu: { WEBKIT_SKIA_ENABLE_CPU_RENDERING: "1" },
  noDmabuf: { WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
  arena2: { MALLOC_ARENA_MAX: "2" },
};

describe("353 variants", { timeout: 15 * 60_000 }, () => {
  const out = {};
  for (const [name, env] of Object.entries(VARIANTS)) {
    it(name, { timeout: 180_000 }, async () => {
      const app = await launch(`z353-${name}`, { env });
      try {
        await waitLive(app);
        await app.find(By.css(".overview .card"), { timeout: 60_000 });
        await sleep(30_000);
        const pid = appPid(app.profile.home);
        const r = measure(pid);
        const web = r.processes.find((p) => p.comm.startsWith("WebKitWebProc"));
        out[name] = {
          core: r.core,
          web: r.web,
          total: r.total,
          coreMaps: topMappings(pid, 8),
          webMaps: web ? topMappings(web.pid, 8) : [],
        };
        await app.shot(name);
        const line = `| ${name} | ${(r.core.rss / 1024).toFixed(0)} / ${(r.core.pss / 1024).toFixed(0)} | ${(r.web.rss / 1024).toFixed(0)} / ${(r.web.pss / 1024).toFixed(0)} | ${(r.total.pss / 1024).toFixed(0)} |`;
        console.log("VARIANT", line);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
        writeFileSync(join(ARTIFACTS, "z353-variants.json"), JSON.stringify(out, null, 2));
      } finally {
        await app.close();
      }
    });
  }
});
