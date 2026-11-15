// xterm.js terminals (pod exec, local shell, debug, node shell): type into
// one and read its screen.

import { By, Key } from "selenium-webdriver";

/**
 * The terminal in the dock's visible pane, or the one under `root` (a CSS
 * selector) if given.
 */
export function terminal(app, root) {
  return new Terminal(app, root);
}

const SCREEN = `
  const roots = arguments[0]
    ? Array.from(document.querySelectorAll(arguments[0]))
    : Array.from(document.querySelectorAll('[data-testid="terminal"]'));
  const term = roots.find((el) => el.offsetParent !== null) ?? null;
  if (!term) return null;
  const rows = term.querySelector('.xterm-rows');
  return rows ? Array.from(rows.children, (r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()).join('\\n') : '';`;

export class Terminal {
  constructor(app, root) {
    this.app = app;
    this.root = root ?? null;
  }

  /** The visible rows as text, one line per row (trailing blanks trimmed). */
  async screen() {
    return (await this.app.js(SCREEN, this.root)) ?? "";
  }

  async #input() {
    return this.app.waitFor(
      async () => {
        const els = await this.app.driver.findElements(
          By.css(`${this.root ?? '[data-testid="terminal"]'} .xterm-helper-textarea`),
        );
        for (const el of els) {
          // The textarea itself is 0x0; its terminal is what must show.
          const shown = await this.app.js("return arguments[0].closest('.xterm')?.offsetParent !== null", el);
          if (shown) return el;
        }
        return null;
      },
      { message: "a visible terminal" },
    );
  }

  /** Wait until the screen matches `pattern` (RegExp or substring); returns the screen. */
  async waitFor(pattern, { timeout = 20_000, message } = {}) {
    const test = typeof pattern === "string" ? (s) => s.includes(pattern) : (s) => pattern.test(s);
    return this.app.waitFor(
      async () => {
        const s = await this.screen();
        return test(s) ? s : null;
      },
      { timeout, message: message ?? `${pattern} in the terminal` },
    );
  }

  /** Wait for a shell prompt (`$`, `#`, `%` or `>` at the end of a line). */
  waitForPrompt(timeout = 30_000) {
    return this.waitFor(/[$#%>]\s*$/m, { timeout, message: "a shell prompt" });
  }

  /**
   * Type `text` key by key (through xterm, like real typing), then Enter
   * unless `enter: false`. Each key is a separate IPC call; `delay` (ms)
   * between keys keeps them from racing. With `delay: 0` the whole text goes
   * in one WebDriver call, which on the local shell has been seen to swap
   * characters (#83).
   */
  async type(text, { enter = true, delay = 15 } = {}) {
    const input = await this.#input();
    if (delay <= 0) {
      await input.sendKeys(text, ...(enter ? [Key.ENTER] : []));
      return;
    }
    for (const ch of text) {
      await input.sendKeys(ch);
      await new Promise((r) => setTimeout(r, delay));
    }
    if (enter) await input.sendKeys(Key.ENTER);
  }

  /**
   * Run a command and return what it printed between two markers, so the
   * echoed command line and the prompt are not part of it.
   */
  async run(command, { timeout = 20_000 } = {}) {
    const tag = `Q${Math.random().toString(36).slice(2, 8)}`;
    // The markers are split in the command line, so only the output matches.
    await this.type(`printf '%s%s\\n' '<${tag}' '>'; ${command}; printf '%s%s\\n' '</${tag}' '>'`);
    const re = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n?</${tag}>`);
    const screen = await this.waitFor(re, { timeout, message: `the output of \`${command}\`` });
    return screen.match(re)[1].trim();
  }

  /** The PTY's `[rows, columns]` as the shell sees them (`stty size`). */
  async size() {
    const out = await this.run("stty size");
    const m = out.match(/(\d+)\s+(\d+)/);
    if (!m) throw new Error(`stty size printed ${JSON.stringify(out)}`);
    return [Number(m[1]), Number(m[2])];
  }
}
