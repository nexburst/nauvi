// Helpers: typing in one burst and pasting into xterm (lib/terminal.mjs).
// Checks (#89): a long command typed in one WebDriver call and a ~4 KB
// paste reach the shell byte for byte, in a local shell and in a pod exec
// terminal. Each typed key is its own input event and IPC call; out of order
// they once turned `printf` into `prnitf`. The shell checks what it got with
// md5sum against the hash computed here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { panelButton, pressCtrl } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 180_000 };
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash("md5").update(s).digest("hex");

/** A deterministic pseudo-random string of `n` characters from `alphabet`. */
function text(n, alphabet, seed) {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

const WORD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Printable ASCII but none of the prompt characters `waitForPrompt` looks
// for, and no control characters the terminal line discipline acts on.
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
  .filter((c) => !"$#%>".includes(c))
  .join("");
// 500 characters typed in one command line (busybox sh edits lines of up to
// 1024).
const LONG = text(500, WORD, 89);
// 64 lines of 63 characters plus a newline: 4096 bytes, each line under the
// 4095-byte limit of a terminal's canonical mode (cat reads it line by line).
const PASTE = Array.from({ length: 64 }, (_, i) => `${text(63, PRINTABLE, 1000 + i)}\n`).join("");

/** Type a long command in one burst; the shell hashes and counts what it got. */
async function typedBurst(term, file) {
  const got = await term.run(`printf %s '${LONG}' > ${file}; md5sum ${file}; wc -c < ${file}`);
  const [hash, , count] = got.split(/\s+/);
  assert.equal(Number(count), LONG.length, `the shell got ${count} of ${LONG.length} characters`);
  assert.equal(hash, md5(LONG), "the typed command reached the shell unchanged");
}

/** Paste ~4 KB into `cat > file`; the shell hashes and counts the file. */
async function pasted(app, term, file) {
  await term.type(`cat > ${file}`);
  // Let cat start (and a shell's bracketed paste mode end) first.
  await sleep(1500);
  await term.paste(PASTE);
  await sleep(1000);
  await pressCtrl(app, "d");
  await term.waitForPrompt();
  await term.type("clear");
  const got = await term.run(`md5sum ${file}; wc -c < ${file}`);
  const [hash, , count] = got.split(/\s+/);
  assert.equal(Number(count), PASTE.length, `the file has ${count} of ${PASTE.length} bytes`);
  assert.equal(hash, md5(PASTE), "the pasted text reached the shell unchanged");
}

describe("terminal input order", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-input", httpPodYaml("shell"));
    waitPodReady(ns, "shell");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("terminal-input", { env: { SHELL } });

  it("a local shell gets a long command typed in one burst", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${CONTEXT}`);
    await term.waitForPrompt();
    await typedBurst(term, "qa-typed.txt");
  });

  it("a local shell gets a 4 KB paste byte for byte", T, async () => {
    const { app } = s;
    await pasted(app, terminal(app), "qa-paste.txt");
  });

  it("a pod exec terminal gets a long command typed in one burst", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "shell");
    await panelButton(app, "Open terminal");
    const term = terminal(app);
    await term.waitForPrompt();
    // The local shell's tab is still open: this one must be the visible one.
    assert.equal(await term.run("hostname"), "shell");
    await typedBurst(term, "/tmp/qa-typed.txt");
  });

  it("a pod exec terminal gets a 4 KB paste byte for byte", T, async () => {
    const { app } = s;
    await pasted(app, terminal(app), "/tmp/qa-paste.txt");
  });
});
