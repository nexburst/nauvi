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
   * Type `text` key by key (through xterm, like real typing) in one burst,
   * then Enter unless `enter: false`. Each key is its own input event; the
   * terminal sends them to the shell in order (#89).
   */
  async type(text, { enter = true } = {}) {
    const input = await this.#input();
    await input.sendKeys(text, ...(enter ? [Key.ENTER] : []));
  }

  /**
   * Paste `text` the way a clipboard paste does: a `paste` event on xterm's
   * textarea, which xterm sends to the shell in one piece (newlines become
   * CR, bracketed if the shell asked for that).
   */
  async paste(text) {
    const input = await this.#input();
    await this.app.js(
      `const [ta, text] = arguments;
       ta.focus();
       const ev = new Event("paste", { bubbles: true, cancelable: true });
       Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
       ta.dispatchEvent(ev);`,
      input,
      text,
    );
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

  /**
   * Press `key` `times` times, `everyMs` apart; returns how long each press
   * took to be taken by the page, ms (WebDriver waits for the key events to
   * be handled, so a busy main thread shows here). For typing while output
   * floods (#115).
   */
  async keyLatencies(key, times = 5, everyMs = 150) {
    const input = await this.#input();
    const out = [];
    for (let i = 0; i < times; i++) {
      const t0 = performance.now();
      await input.sendKeys(key);
      out.push(Math.round(performance.now() - t0));
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return out;
  }

  /** The PTY's `[rows, columns]` as the shell sees them (`stty size`). */
  async size() {
    const out = await this.run("stty size");
    const m = out.match(/(\d+)\s+(\d+)/);
    if (!m) throw new Error(`stty size printed ${JSON.stringify(out)}`);
    return [Number(m[1]), Number(m[2])];
  }
}
