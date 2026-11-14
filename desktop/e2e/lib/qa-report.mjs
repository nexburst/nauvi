// Turn a qa.sh output dir into a short Markdown report (stdout): a summary
// table per scenario, the failures, and the screenshots each one took.
//
// Usage: node lib/qa-report.mjs <out-dir>

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node qa-report.mjs <out-dir>");
  process.exit(2);
}

const resultsPath = join(out, "results.jsonl");
const results = existsSync(resultsPath)
  ? readFileSync(resultsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const files = readdirSync(out);
const tests = results.filter((r) => !r.suite);
const byFile = new Map();
for (const r of tests) {
  const key = basename(r.file || "?", ".test.mjs");
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push(r);
}
// A skipped suite, or one whose before() failed, reports only the suite.
for (const r of results.filter((r) => r.suite && r.status !== "pass")) {
  const key = basename(r.file || "?", ".test.mjs");
  if (!byFile.has(key)) byFile.set(key, [{ ...r, name: r.status === "fail" ? `${r.name} (set-up)` : r.name }]);
}

const icon = { pass: "✅", fail: "❌", skip: "⏭️" };
const count = (rs, s) => rs.filter((r) => r.status === s).length;
const cell = (s) => String(s).replace(/\|/g, "\\|");

const lines = ["# kubeloupe QA run", ""];
const all = [...byFile.values()].flat();
lines.push(
  `${count(all, "pass")} passed, ${count(all, "fail")} failed, ${count(all, "skip")} skipped, in ${byFile.size} scenario file(s).`,
  "",
  "| scenario | passed | failed | skipped | time |",
  "| --- | --- | --- | --- | --- |",
);
for (const [name, rs] of byFile) {
  const secs = Math.round(rs.reduce((a, r) => a + r.ms, 0) / 1000);
  lines.push(`| ${cell(name)} | ${count(rs, "pass")} | ${count(rs, "fail")} | ${count(rs, "skip")} | ${secs} s |`);
}

for (const [name, rs] of byFile) {
  lines.push("", `## ${name}`, "");
  for (const r of rs) {
    const extra = r.status === "fail" ? `: ${r.error}` : r.status === "skip" && r.skipReason ? ` (${r.skipReason})` : "";
    lines.push(`- ${icon[r.status]} ${r.name} (${Math.round(r.ms / 1000)} s)${extra}`);
  }
  const shots = files.filter((f) => f.startsWith(`${name}-`) && f.endsWith(".png"));
  if (shots.length) lines.push("", `Screenshots: ${shots.map((f) => `\`${f}\``).join(", ")}`);
}

if (!results.length) lines.push("", "No results: the run did not get to the tests. See run.log.");
console.log(lines.join("\n"));
