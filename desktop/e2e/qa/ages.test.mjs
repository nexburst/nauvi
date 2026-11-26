// kubectl-style ages and the creation time (#380), at 1280x800 in the dark
// and the light theme:
// - every kube-system pod's Age cell is what `kubectl get pods` prints next
//   to it (two units where kubectl has them: 3m10s, 3h12m, 7d20h)
// - the Age cell's tooltip is the creation time
// - the detail panel shows the age with the creation time, in local time
//   (the app runs with TZ=America/Mexico_City) and, after a restart with
//   time_zone "utc" in settings.json, in UTC
// - a ConfigMap in a temp namespace, once 2 minutes old, shows "2m<s>s" in
//   the table, like kubectl

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { openKind } from "./area-2-helpers.mjs";

const T = { timeout: 240_000 };
const TZ = "America/Mexico_City";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ns = "";
let pod = "";
let created = 0;

/** "2026-11-09 14:02:03" in `timeZone`. */
const wallClock = (ms, timeZone) => new Date(ms).toLocaleString("sv-SE", { timeZone, hour12: false });

/** name -> kubectl's AGE, for `kubectl get <args>` (AGE is the last column). */
function kubectlAges(args) {
  const out = kubectl(["get", ...args, "--no-headers"]);
  return new Map(
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const f = l.trim().split(/\s+/);
        return [f[0], f[f.length - 1]];
      }),
  );
}

/** name -> { age, title } of the rendered rows' Age cells. */
async function appAges(app) {
  const rows = await app.js(`
    const heads = Array.from(document.querySelectorAll('[role="columnheader"]'), (h) => h.textContent.trim());
    const at = heads.indexOf("Age");
    const name = heads.indexOf("Name");
    if (at < 0 || name < 0) return [];
    return Array.from(document.querySelectorAll('[data-testid="resource-row"]'), (r) => {
      // The checkbox cell has a header too, so the indexes line up.
      const c = r.querySelectorAll('[role="gridcell"]');
      // A cut name (#482) has its whole value as its aria-label.
      return [c[name]?.getAttribute("aria-label") ?? c[name]?.textContent.trim(), c[at]?.textContent.trim(), c[at]?.getAttribute("title") ?? ""];
    });
  `);
  return new Map(rows.map(([n, age, title]) => [n, { age, title }]));
}

/** Retry until every row kubectl lists has kubectl's age in the app (ages tick). */
async function agesMatch(app, args) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const want = kubectlAges(args);
    const got = await appAges(app);
    const diff = [...want].filter(([n, a]) => got.get(n)?.age !== a);
    if (want.size > 0 && diff.length === 0) return { want, got };
    last = JSON.stringify(diff.map(([n, a]) => [n, a, got.get(n)?.age]));
    await sleep(500);
  }
  throw new Error(`ages differ from kubectl ([name, kubectl, app]): ${last}`);
}

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

const metaAge = (app) =>
  app.js(`return document.querySelector('[data-testid="meta-age"]')?.textContent.trim().replace(/\\s+/g, " ") ?? ""`);

before(() => {
  ns = tempNamespace("qa-ages", "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: qa-ages }\ndata: { a: b }\n");
  pod = kubectl([
    "get",
    "pods",
    "-n",
    "kube-system",
    "--sort-by=.metadata.creationTimestamp",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]);
  created = Date.parse(
    kubectl(["get", "pod", "-n", "kube-system", pod, "-o", "jsonpath={.metadata.creationTimestamp}"]),
  );
});
after(() => deleteNamespace(ns));

describe("kubectl-style ages", { timeout: 15 * 60_000 }, () => {
  const s = appSession("ages", { env: { TZ } });

  it("kube-system pods: the Age column is kubectl's AGE, with the creation time as its tooltip", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openKind(app, "Pods", "kube-system");
    const { want, got } = await agesMatch(app, ["pods", "-n", "kube-system"]);
    console.log(`kubectl AGE: ${JSON.stringify([...want])}`);
    assert.equal(got.get(pod).title, `Created ${wallClock(created, TZ)}`);
    await bothThemes(app, "pods-ages");
  });

  it("the detail panel shows the age and the creation time in local time", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", "kube-system", pod);
    // The age ticks: retry until it is kubectl's at the same moment.
    const text = await app.waitFor(
      async () => {
        const t = await metaAge(app);
        return t && t.split(" ")[0] === kubectlAges(["pod", "-n", "kube-system", pod]).get(pod) ? t : null;
      },
      { message: "the Age row with kubectl's AGE" },
    );
    console.log(`detail Age: ${text}`);
    assert.match(text, new RegExp(`^\\S+ \\(${wallClock(created, TZ)}\\)$`));
    await bothThemes(app, "detail-local");
  });

  it("with time_zone utc, the creation time is in UTC", T, async () => {
    const { app } = s;
    await app.restart({
      beforeStart: () => app.profile.writeSettings({ ...(app.profile.settings() ?? {}), time_zone: "utc" }),
    });
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Pods", "kube-system", pod);
    const want = `(${wallClock(created, "UTC")} UTC)`;
    const text = await app.waitFor(async () => ((await metaAge(app)).endsWith(want) ? metaAge(app) : null), {
      message: `the Age row ending in ${want}`,
    });
    console.log(`detail Age (UTC): ${text}`);
    const title = (await appAges(app)).get(pod)?.title;
    assert.equal(title, `Created ${wallClock(created, "UTC")} UTC`);
    await bothThemes(app, "detail-utc");
  });

  it("a ConfigMap two minutes old shows minutes and seconds, like kubectl", T, async () => {
    const { app } = s;
    // After the restart the picker holds kube-system: select only the temp namespace.
    await app.nav("Config Maps");
    await pickNamespaces(app, [ns]);
    await app.filter("qa-ages");
    // Under 2 minutes kubectl prints seconds only ("95s").
    await app.waitFor(async () => /^\dm\d+s$/.test(kubectlAges(["configmap", "-n", ns, "qa-ages"]).get("qa-ages")), {
      timeout: 150_000,
      interval: 1000,
      message: "kubectl's AGE of qa-ages in minutes and seconds",
    });
    const { got } = await agesMatch(app, ["configmap", "-n", ns, "qa-ages"]);
    console.log(`qa-ages: ${got.get("qa-ages").age}`);
    assert.match(got.get("qa-ages").age, /^\dm\d+s$/);
    await bothThemes(app, "configmap-ages");
  });
});
