import type { MetricsAddonRequest, NodeDisk } from "./bindings";
import { formatMemory } from "./format";

/** The option metrics-server needs on kind (`KUBELET_INSECURE_TLS` in Rust). */
export const KUBELET_INSECURE_TLS = "kubelet-insecure-tls";

/**
 * Whether a context name looks like a local cluster whose kubelets have
 * self-signed certificates (kind, minikube, k3d, Docker Desktop). Only for
 * a hint next to the option: the option itself stays off until ticked.
 */
export function looksLocal(context: string): boolean {
  return /^(kind-|k3d-)/.test(context) || context === "minikube" || context === "docker-desktop";
}

/** Whether two requests install the same thing (the dry run's may be confirmed). */
export function sameAddonRequest(a: MetricsAddonRequest | null, b: MetricsAddonRequest | null): boolean {
  if (!a || !b) return false;
  return (
    a.addon === b.addon &&
    a.name === b.name &&
    a.namespace === b.namespace &&
    a.values === b.values &&
    a.create_namespace === b.create_namespace &&
    a.reveal === b.reveal &&
    a.options.length === b.options.length &&
    a.options.every((o) => b.options.includes(o))
  );
}

/** A node's Disk cell: "12.5Gi / 58.4Gi (21%)". */
export function diskText(d: NodeDisk): string {
  return `${formatMemory(d.used_bytes)} / ${formatMemory(d.size_bytes)} (${diskPercent(d)}%)`;
}

/** How full a node's root filesystem is, 0-100. */
export function diskPercent(d: NodeDisk): number {
  return d.size_bytes > 0 ? Math.round((d.used_bytes / d.size_bytes) * 100) : 0;
}
