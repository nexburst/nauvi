// nauvi:// links (`commands/links.rs`, #299). Tests queue a request with
// `fake.queueLink` / `fake.openLink`.

import type { AreaHandlers, FakeState } from "./state";

/** Like the backend's encoding: everything but unreserved characters. */
const encode = (part: string) =>
  [...new TextEncoder().encode(part)]
    .map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");

export function linksHandlers(s: FakeState) {
  return {
    cmdObjectLink: (resource, namespace, name) => {
      const context = s.cluster.contexts.find((c) => c.current)?.name ?? "";
      const parts = [context, resource.group || "core", resource.version, resource.kind, namespace || "_", name];
      return `nauvi://${parts.map(encode).join("/")}`;
    },
    cmdTakeLink: () => {
      const request = s.link;
      s.link = null;
      return request;
    },
  } satisfies AreaHandlers;
}
