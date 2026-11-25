// A container's env with values (`commands/pod_env.rs`, #447), from
// `fixtures/pod-env.ts`. A container without a fixture gets its env names
// from the pod detail, each a literal "value".
//
// A test can hold `cmd_reveal_pod_env` answers back: set
// `window.__podEnvRevealGate` to a promise, and the reveal answers once it
// settles (a reveal still in flight while the list reloads).

import type { ContainerEnv } from "../../lib/bindings";
import { POD_ENV, POD_ENV_LITERALS } from "../fixtures/pod-env";
import type { AreaHandlers, FakeState } from "./state";

declare global {
  interface Window {
    __podEnvRevealGate?: Promise<unknown>;
  }
}

function fallback(s: FakeState, namespace: string, pod: string, container: string): ContainerEnv {
  const d = s.cluster.details[`v1/pods|${namespace}/${pod}`];
  const c = d?.pod?.containers.find((c) => c.name === container);
  if (!c) throw `the pod has no container ${container}`;
  return {
    container,
    from: [],
    env: c.env
      .filter((e) => !e.name.endsWith("*"))
      .map((e) => ({
        name: e.name,
        kind: "literal",
        object: "",
        key: "",
        value: "value",
        hidden: false,
        error: "",
        overridden: false,
      })),
  };
}

export function podEnvHandlers(s: FakeState) {
  return {
    cmdPodEnv: (namespace, pod, container) => {
      const known = POD_ENV[`${namespace}/${pod}/${container}`];
      return known ? structuredClone(known) : fallback(s, namespace, pod, container);
    },
    cmdRevealPodEnv: async (namespace, pod, container, group, index, name) => {
      await window.__podEnvRevealGate;
      const env = POD_ENV[`${namespace}/${pod}/${container}`];
      const row = group < 0 ? env?.env[index] : env?.from[group]?.rows[index];
      const v = POD_ENV_LITERALS[`${namespace}/${pod}/${container}/${name}`];
      if (row?.name !== name || v === undefined) throw `container ${container} has no variable ${name} there any more`;
      return v;
    },
  } satisfies AreaHandlers;
}
