// Split the scenario files into N shards of about the same run time, and
// print the files of one of them, one per line (qa.sh --shard I/N).
//
// Usage: node lib/shard.mjs I/N file...
//        node lib/shard.mjs --weights results.jsonl...   (print new weights)
//
// The weights are seconds per scenario file from earlier CI runs, in
// qa-weights.json (a file not listed counts as DEFAULT). Files are dealt
// heaviest first, each to the shard with the least time so far (ties: the
// lower shard, then by name), so every runner computes the same split.
// Refresh the weights from a full run with --weights.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT = 60;
const here = dirname(fileURLToPath(import.meta.url));
const nameOf = (f) => basename(f).replace(/\.test\.mjs$/, "");

export function shard(files, index, total, weights) {
  const w = (f) => weights[nameOf(f)] ?? DEFAULT;
  const sorted = [...files].sort((a, b) => w(b) - w(a) || nameOf(a).localeCompare(nameOf(b)));
  const load = Array(total).fill(0);
  const picked = Array.from({ length: total }, () => []);
  for (const f of sorted) {
    let best = 0;
    for (let i = 1; i < total; i++) if (load[i] < load[best]) best = i;
    load[best] += w(f);
    picked[best].push(f);
  }
  // Run order: as given (qa.sh passes them sorted, smoke first).
  return files.filter((f) => picked[index - 1].includes(f));
}

function weightsFrom(paths) {
  const out = {};
  for (const p of paths) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.nesting !== 0 || !r.file) continue;
      const k = nameOf(r.file);
      out[k] = (out[k] ?? 0) + Math.round(r.ms / 1000);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [spec, ...files] = process.argv.slice(2);
  if (spec === "--weights") {
    console.log(JSON.stringify(weightsFrom(files), null, 2));
    process.exit(0);
  }
  const m = /^(\d+)\/(\d+)$/.exec(spec || "");
  const index = m && Number(m[1]);
  const total = m && Number(m[2]);
  if (!m || total < 1 || index < 1 || index > total) {
    console.error("usage: node lib/shard.mjs I/N file...  (1 <= I <= N)");
    process.exit(2);
  }
  const weights = JSON.parse(readFileSync(join(here, "..", "qa-weights.json"), "utf8"));
  for (const f of shard(files, index, total, weights)) console.log(f);
}
