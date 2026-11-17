// Windows only (WebView2, ConPTY); no cluster needed, so it also runs in
// qa.yml's Windows job.
// Checks (#43, #45 maintainer checks in #83): a local terminal runs pwsh,
// else Windows PowerShell, else cmd, in a ConPTY with KUBECONFIG pointing
// at the app's context first; "Open in new window" opens a second window.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { appSession, unreachableKubeconfig } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { openNewWindow, switchTo, windowHandles, windowTitles } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const WINDOWS = process.platform === "win32";
const CONTEXT = "qa-unreachable";

const pathDirs = () => (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
const has = (dir, exe) => existsSync(join(dir, exe));
const onPath = (exe) => pathDirs().some((d) => has(d, exe));
/** PATH without the folders that hold any of `exes`. */
const pathWithout = (...exes) =>
  pathDirs()
    .filter((d) => !exes.some((exe) => has(d, exe)))
    .join(delimiter);

const SHELLS = [
  {
    name: "pwsh",
    skip: !WINDOWS ? "Windows only" : !onPath("pwsh.exe") && "pwsh is not installed",
    path: () => pathDirs().join(delimiter),
    kind: "ps",
    edition: "Core",
  },
  {
    name: "powershell",
    skip: !WINDOWS ? "Windows only" : !onPath("powershell.exe") && "Windows PowerShell is not on PATH",
    path: () => pathWithout("pwsh.exe"),
    kind: "ps",
    edition: "Desktop",
  },
  {
    name: "cmd",
    skip: !WINDOWS && "Windows only",
    path: () => pathWithout("pwsh.exe", "powershell.exe"),
    kind: "cmd",
  },
];

/**
 * Run `commands` in the shell and return what they printed between two
 * markers. The markers are built so the echoed command line never matches.
 */
async function run(term, kind, commands) {
  const tag = `Q${Math.random().toString(36).slice(2, 8)}`;
  const line =
    kind === "ps"
      ? [`Write-Output ('<'+'${tag}>')`, ...commands, `Write-Output ('</'+'${tag}>')`].join("; ")
      : [`echo ^<${tag}^>`, ...commands, `echo ^</${tag}^>`].join(" & ");
  await term.type(line);
  const re = new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n?^</${tag}>`, "m");
  const screen = await term.waitFor(re, { timeout: 30_000, message: `the output of ${line}` });
  return screen.match(re)[1].trim();
}

for (const shell of SHELLS) {
  describe(`Windows local terminal: ${shell.name}`, { timeout: 10 * 60_000, skip: shell.skip }, () => {
    const s = appSession(`windows-${shell.name}`, () => ({
      kubeconfig: unreachableKubeconfig(),
      env: { PATH: shell.path() },
    }));

    it(`opens ${shell.name} with KUBECONFIG at the app's context`, T, async () => {
      const { app } = s;
      await app.find(By.css("header"));
      await app.palette("local term", "New local terminal");
      const term = terminal(app);
      await term.waitFor(`kubectl uses context ${CONTEXT}`, { timeout: 30_000 });
      await term.waitFor(/>\s*$/m, { timeout: 30_000, message: "a prompt" });
      if (shell.kind === "ps") {
        const edition = await run(term, "ps", ["$PSVersionTable.PSEdition"]);
        assert.equal(edition, shell.edition);
      }
      const kubeconfig = await run(term, shell.kind, [shell.kind === "ps" ? "$env:KUBECONFIG" : "echo %KUBECONFIG%"]);
      console.log(`KUBECONFIG in ${shell.name}: ${kubeconfig}`);
      // The temp kubeconfig first, then the app's own, separated by `;`.
      const parts = kubeconfig.replace(/\s*\n\s*/g, "").split(";");
      assert.ok(parts.length >= 2, kubeconfig);
      assert.match(parts[0], /nauvi-shell-\d+-\d+\.yaml$/);
      if (onPath("kubectl.exe")) {
        assert.equal(await run(term, shell.kind, ["kubectl config current-context"]), CONTEXT);
      }
      await app.shot(`${shell.name}-terminal`);
    });
  });
}

describe("Windows: several windows", { timeout: 10 * 60_000, skip: !WINDOWS && "Windows only" }, () => {
  const s = appSession("windows-windows", { kubeconfig: unreachableKubeconfig() });

  it("opens a second window and keeps the first after closing it", T, async () => {
    const { app } = s;
    await app.find(By.css("header"));
    const main = await app.driver.getWindowHandle();
    const second = await openNewWindow(app);
    await switchTo(app, second);
    await app.find(By.css('[role="alert"]'), { timeout: 60_000 });
    const titles = await windowTitles(app);
    console.log(`titles: ${JSON.stringify(Object.values(titles))}`);
    assert.equal(Object.keys(titles).length, 2);
    await app.shot("second-window");
    await app.driver.close();
    await switchTo(app, main);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window left" });
    await app.find(By.css("header"));
  });
});
