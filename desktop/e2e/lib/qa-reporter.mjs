// node:test reporter used by qa.sh: one JSON line per finished test or
// suite, read by qa-report.mjs.

import { relative } from "node:path";

export default async function* qaReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data;
    // A `todo` test is a known, filed bug: it runs, but never fails the run.
    const todo = d.todo !== undefined && d.todo !== false;
    const status =
      d.skip !== undefined && d.skip !== false
        ? "skip"
        : todo
          ? event.type === "test:pass"
            ? "pass"
            : "todo"
          : event.type === "test:pass"
            ? "pass"
            : "fail";
    const err = d.details?.error;
    const cause = err?.cause ?? err;
    yield `${JSON.stringify({
      file: d.file ? relative(process.cwd(), d.file) : "",
      name: d.name,
      nesting: d.nesting,
      suite: d.details?.type === "suite",
      status,
      skipReason: typeof d.skip === "string" ? d.skip : typeof d.todo === "string" ? d.todo : "",
      ms: Math.round(d.details?.duration_ms ?? 0),
      error: status === "fail" || status === "todo" ? String(cause?.message ?? cause ?? "").split("\n")[0].slice(0, 300) : "",
    })}\n`;
  }
}
