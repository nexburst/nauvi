/**
 * Status text and banner message for an error from loading cluster data.
 *
 * Connecting to a cluster fails with a readable message (see `src/auth.rs`);
 * its prefix tells a failed login, a certificate problem or a machine
 * without any kubeconfig apart from an unreachable cluster. Keep the
 * prefixes in sync with that file.
 */
export function clusterError(e: unknown): { status: string; message: string } {
  const message = String(e);
  if (message.startsWith("Login to `")) return { status: "Login failed", message };
  if (message.startsWith("Certificate problem")) return { status: "Certificate problem", message };
  if (message.startsWith("No kubeconfig found")) {
    return { status: "No kubeconfig", message: `${message} ${NO_KUBECONFIG_HINT}` };
  }
  if (message.startsWith("Cannot reach the cluster")) {
    return { status: "Cluster unreachable", message };
  }
  return { status: "Cluster unreachable", message: "Could not reach the cluster: " + message };
}

/** What to do without a kubeconfig: the catalog adds files and pasted ones. */
export const NO_KUBECONFIG_HINT =
  "Open the cluster catalog (the grid button in the header) to add a kubeconfig file or folder, or paste one.";
