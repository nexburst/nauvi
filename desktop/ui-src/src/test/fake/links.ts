// nauvi:// links (`commands/links.rs`, #299). Tests queue a request with
// `fake.queueLink` / `fake.openLink`.

import type { LinkRequest } from "../../lib/bindings";
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
    // A link clicked in an Ask AI terminal (#548): six parts and a known
    // context open, anything else is a notice (the backend checks more).
    cmdCheckLink: (link): LinkRequest => {
      const parts = link.replace(/^nauvi:\/\//i, "").split("/").map(decodeURIComponent);
      if (!/^nauvi:\/\//i.test(link) || parts.length !== 6 || parts.some((p) => !p)) {
        return { type: "notice", message: "This nauvi link can't be opened: it is not a link. Nothing was opened." };
      }
      const [context, group, version, kind, namespace, name] = parts;
      if (!s.cluster.contexts.some((c) => c.name === context)) {
        return {
          type: "notice",
          message: `This link is for the context ${context}, which is not in your kubeconfigs. Nothing was opened.`,
        };
      }
      const g = group === "core" ? "" : group;
      return { type: "open", link: { context, group: g, version, kind, namespace: namespace === "_" ? "" : namespace, name } };
    },
    cmdTakeLink: () => {
      const request = s.link;
      s.link = null;
      return request;
    },
  } satisfies AreaHandlers;
}
