// A cluster's proxy (`commands/proxy.rs`, #329). Kept in memory per fake
// state, by context id, with the full URL; like the backend, the UI only
// gets it with the user and password masked. Tests check what the page
// shows, and the arguments of `fake.calls("cmdSetClusterProxy")`.

import type { ClusterProxyInfo } from "../../lib/bindings";
import { fullContext } from "../fixtures/catalog";
import type { AreaHandlers, FakeState } from "./state";

interface Saved {
  url: string;
  local: boolean;
}

const stores = new WeakMap<FakeState, Map<string, Saved>>();

export function fakeProxies(s: FakeState): Map<string, Saved> {
  let m = stores.get(s);
  if (!m) {
    m = new Map();
    stores.set(s, m);
  }
  return m;
}

const MASK = "[redacted]";

function redact(url: string): string {
  return url.replace(/^([a-z0-9]+:\/\/)[^/@]*@/i, `$1${MASK}@`);
}

/** The backend's checks, in short (`nauvi::proxy::ProxyUrl::parse`). */
function parse(text: string): string {
  const t = text.trim();
  const m = /^([a-z0-9]+):\/\/(?:([^@/]*)@)?([^/:@\s]+)(?::(\d*))?\/?$/i.exec(t);
  if (!t.includes("://")) throw "Start the proxy URL with http://, https:// or socks5://, for example http://proxy.example:3128.";
  const scheme = t.split("://")[0].toLowerCase();
  if (!["http", "https", "socks5"].includes(scheme))
    throw `A proxy URL starts with http://, https:// or socks5://, not ${scheme}://.`;
  if (!m) throw `Not a valid proxy URL: ${redact(t)}.`;
  if (m[2] !== undefined && scheme === "socks5")
    throw "A user name and password are not supported for SOCKS5 proxies; use an HTTP proxy for that, or a SOCKS5 proxy without them.";
  const port = m[4] || { http: "80", https: "443", socks5: "1080" }[scheme];
  return `${scheme}://${m[2] !== undefined ? m[2] + "@" : ""}${m[3]}:${port}`;
}

function isLocal(server: string): boolean {
  return /^https?:\/\/(localhost|127\.[0-9.]+|\[::1\])(:|\/|$)/i.test(server);
}

export function proxyHandlers(s: FakeState) {
  const info = (cluster: string): ClusterProxyInfo => {
    const ctx = s.cluster.contexts.find((c) => c.name === cluster);
    if (!ctx) throw `There is no context ${cluster} in your kubeconfigs.`;
    const saved = fakeProxies(s).get(cluster);
    const serverLocal = isLocal(fullContext(ctx).server);
    const route =
      saved && (saved.local || !serverLocal)
        ? `Connects through ${redact(saved.url)}.`
        : saved
          ? "Connects directly: the cluster is on this machine, and the proxy is not used for it unless you ask below."
          : "Connects directly. Proxy environment variables (HTTPS_PROXY) are not used.";
    return {
      url: saved ? redact(saved.url) : "",
      has_credentials: !!saved && saved.url !== redact(saved.url),
      local: saved?.local ?? false,
      kubeconfig_proxy: "",
      server_local: serverLocal,
      route,
    };
  };
  return {
    cmdGetClusterProxy: (id) => info(id),
    cmdSetClusterProxy: (id, url, local) => {
      info(id);
      const proxies = fakeProxies(s);
      if (url === null) {
        const saved = proxies.get(id);
        if (!saved) throw `No proxy is set for ${id}.`;
        proxies.set(id, { ...saved, local });
      } else if (url.trim() === "") {
        proxies.delete(id);
      } else {
        proxies.set(id, { url: parse(url), local });
      }
      return info(id);
    },
  } satisfies AreaHandlers;
}
