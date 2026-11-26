// Field managers in words (#495). Server-side apply names the writer of each
// field by its field manager, e.g. "kubectl-client-side-apply" or
// "kube-controller-manager"; the YAML editor says which tool that is.

const KNOWN: Record<string, string> = {
  "kubectl-client-side-apply": "kubectl apply",
  kubectl: "kubectl",
  helm: "Helm",
  "kube-controller-manager": "a Kubernetes controller",
  "argocd-controller": "Argo CD",
  "argocd-application-controller": "Argo CD",
  "kustomize-controller": "Flux",
  "helm-controller": "Flux (Helm)",
};

/**
 * The tool behind a field manager: "kubectl apply", "Helm", "a Kubernetes
 * controller". Unknown managers are shown as they are.
 */
export function managerLabel(manager: string): string {
  const known = KNOWN[manager];
  if (known) return known;
  const verb = /^kubectl-(.+)$/.exec(manager)?.[1];
  if (verb) return `kubectl ${verb.replace(/-/g, " ")}`;
  return manager;
}

/** A sentence naming the tools of `managers`: "Helm", "kubectl apply and Helm". */
export function toolList(managers: readonly string[]): string {
  const names = [...new Set(managers.map(managerLabel))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
