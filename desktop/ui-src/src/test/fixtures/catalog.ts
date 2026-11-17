// The cluster catalog of the fake backend (#78): kubeconfig sources, what
// adding a file brings in, and each context's status check.

import type { ContextCheck, ContextInfo_Serialize, SourceInfo } from "../../lib/bindings";

/** A context as tests write it: the rest is filled in by `fullContext`. */
export type FakeContext = Pick<ContextInfo_Serialize, "name" | "current" | "namespace"> & Partial<ContextInfo_Serialize>;

export const DEFAULT_KUBECONFIG = "/home/user/.kube/config";

/** `ctx` with every `ContextInfo` field, as `cmd_list_contexts` sends it. */
export function fullContext(ctx: FakeContext): ContextInfo_Serialize {
  return {
    context: ctx.name,
    cluster: ctx.name,
    user: `${ctx.name}-admin`,
    server: `https://${ctx.name.replace(/[^a-z0-9-]/gi, "-")}.example:6443`,
    file: DEFAULT_KUBECONFIG,
    source: "",
    login_command: "",
    login_plugin: false,
    local_files: [],
    ...ctx,
  };
}

export interface FakeCatalog {
  sources: SourceInfo[];
  /** What `cmd_check_context` answers, by context id (default: connected). */
  checks: Record<string, ContextCheck>;
  /** Paths `cmd_add_kubeconfig_source` accepts, with the contexts each brings in. */
  files: Record<string, FakeContext[]>;
  /** Where pasted kubeconfigs are saved. */
  pastedDir: string;
  /** The answers about added sources' login commands, by `source\ncommand` (#201). */
  answers: Record<string, boolean>;
  /** Login plugin runs per context id: what a check would have started. */
  pluginRuns: Record<string, number>;
}

export function defaultCatalog(): FakeCatalog {
  return {
    sources: [{ path: DEFAULT_KUBECONFIG, kind: "kubeconfig", contexts: 2, files: 1, error: "" }],
    checks: {},
    files: {},
    pastedDir: "/home/user/.config/dev.nauvi.app/kubeconfigs",
    answers: {},
    pluginRuns: {},
  };
}

export function connected(name: string): ContextCheck {
  return { name, state: "connected", message: "", version: "v1.31.0" };
}
