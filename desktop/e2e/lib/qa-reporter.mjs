// node:test reporter used by qa.sh: one JSON line per finished test or
// suite, read by qa-report.mjs.

import { relative } from "node:path";

export default async function* qaReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data;
    const status = d.skip !== undefined && d.skip !== false ? "skip" : event.type === "test:pass" ? "pass" : "fail";
    const err = d.details?.error;
    const cause = err?.cause ?? err;
    yield `${JSON.stringify({
      file: d.file ? relative(process.cwd(), d.file) : "",
      name: d.name,
      nesting: d.nesting,
      suite: d.details?.type === "suite",
      status,
      skipReason: typeof d.skip === "string" ? d.skip : "",
      ms: Math.round(d.details?.duration_ms ?? 0),
      error: status === "fail" ? String(cause?.message ?? cause ?? "").split("\n")[0].slice(0, 300) : "",
    })}\n`;
  }
}
