// A private home for one app (and its restarts): its settings, Downloads
// and an "Open in browser" recorder, so a run never reads or changes the
// developer's own ~/.config/com.kubeloupe.app or opens a real browser.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Profile {
  constructor(home) {
    /** `HOME` of the app. */
    this.home = home;
    /** `app_config_dir()` on Linux: settings.json lives here. */
    this.configDir = join(home, ".config", "com.kubeloupe.app");
    this.settingsPath = join(this.configDir, "settings.json");
    /** Where log Download writes (`$HOME/Downloads`). */
    this.downloads = join(home, "Downloads");
    /** Put first on the app's `PATH`: holds the `xdg-open` recorder. */
    this.bin = join(home, ".qa-bin");
    this.openedLog = join(home, ".qa-opened");
    for (const d of [this.configDir, this.downloads, this.bin]) mkdirSync(d, { recursive: true });
    this.#writeRecorder();
  }

  /**
   * The opener plugin runs `xdg-open <url>` (then gio, gnome-open, ...);
   * `xdg-open` itself honours `$BROWSER`. Both point at this script, which
   * only records the URL.
   */
  #writeRecorder() {
    const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${this.openedLog}'\n`;
    for (const name of ["xdg-open", "gio", "gnome-open", "kde-open", "qa-browser"]) {
      const p = join(this.bin, name);
      writeFileSync(p, script);
      chmodSync(p, 0o755);
    }
  }

  /** The environment the app gets for this profile. */
  env(basePath = process.env.PATH ?? "") {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      XDG_DATA_HOME: join(this.home, ".local", "share"),
      XDG_CACHE_HOME: join(this.home, ".cache"),
      PATH: `${this.bin}:${basePath}`,
      BROWSER: join(this.bin, "qa-browser"),
    };
  }

  /** URLs the app asked the system to open, oldest first. */
  opened() {
    if (!existsSync(this.openedLog)) return [];
    return readFileSync(this.openedLog, "utf8").split("\n").filter(Boolean);
  }

  /** The parsed settings.json, or null if the app hasn't written one. */
  settings() {
    try {
      return JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Replace settings.json (e.g. with garbage, to test recovery). */
  writeSettings(text) {
    writeFileSync(this.settingsPath, typeof text === "string" ? text : JSON.stringify(text, null, 2));
  }

  downloadedFiles() {
    return readdirSync(this.downloads);
  }

  /** Wait for a file in Downloads whose name matches `pattern`; returns its path. */
  async waitForDownload(pattern, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = this.downloadedFiles().find((f) => pattern.test(f));
      if (hit) return join(this.downloads, hit);
      if (Date.now() > deadline) {
        throw new Error(`no file matching ${pattern} in ${this.downloads} (has: ${this.downloadedFiles().join(", ") || "nothing"})`);
      }
      await sleep(250);
    }
  }

  remove() {
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function createProfile() {
  return new Profile(mkdtempSync(join(tmpdir(), "kubeloupe-qa-home-")));
}
