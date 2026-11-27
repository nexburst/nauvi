// Misconfigurations (`commands/image_config.rs`, #538), from
// `fixtures/image-config.ts` unless a test sets `cluster.imageConfig`.
// Like the backend, it refuses while image security is off for the
// current context, and with a scanner on this computer as the only
// Source (#563).

import type { ConfigSummary, ImageConfigList } from "../../lib/bindings";
import {
  DEFAULT_IMAGE_SECURITY,
  imageSecurityOn,
} from "../../lib/imageSecurity";
import { imageConfigFixture } from "../fixtures/image-config";
import type { FakeImageConfig } from "../fixtures/image-config";
import type { AreaHandlers, FakeState } from "./state";

const OFF =
  "Image security is off for this cluster. Turn it on in Settings → Image security, or in this cluster's settings.";

const LOCAL_ONLY =
  "Configuration checks come from the Trivy Operator or Kubescape in the cluster. Source is set to a scanner on this computer only, so nauvi reads no reports from the cluster.";

/** Why nothing is read, or nothing. */
function refusal(s: FakeState): string | null {
  if (!enabled(s)) return OFF;
  const app = s.cluster.settings.image_security ?? DEFAULT_IMAGE_SECURITY;
  return app.source === "local" ? LOCAL_ONLY : null;
}

function data(s: FakeState): FakeImageConfig {
  s.cluster.imageConfig ??= imageConfigFixture();
  return s.cluster.imageConfig;
}

function enabled(s: FakeState): boolean {
  const ctx = s.cluster.contexts.find((c) => c.current)?.name ?? "";
  const app = s.cluster.settings.image_security ?? DEFAULT_IMAGE_SECURITY;
  return imageSecurityOn(app, s.cluster.settings.contexts[ctx]?.image_security);
}

function summary(s: FakeState, namespaces: string[]): ConfigSummary {
  const d = data(s);
  const base: ConfigSummary = {
    state: d.state,
    namespace: namespaces.length === 1 ? namespaces[0] : "",
    namespaces_read: [],
    workloads: [],
    forbidden_namespaces: [],
    all_namespaces_allowed: false,
    notes: [...d.notes],
  };
  if (d.state !== "ok") {
    if (d.state === "forbidden") base.forbidden_namespaces = [...namespaces];
    return base;
  }
  const forbidden = namespaces.filter((n) => d.forbidden.includes(n));
  if (namespaces.length > 0 && forbidden.length === namespaces.length) {
    return {
      ...base,
      state: "forbidden",
      forbidden_namespaces: forbidden,
      all_namespaces_allowed: true,
      notes: [],
    };
  }
  const read = namespaces.filter((n) => !forbidden.includes(n));
  const workloads = d.workloads.filter(
    (w) => read.length === 0 || read.includes(w.target.namespace),
  );
  return {
    ...base,
    namespaces_read: namespaces.length > 1 ? read : [],
    forbidden_namespaces: forbidden,
    workloads: structuredClone(workloads),
  };
}

export function imageConfigHandlers(s: FakeState) {
  return {
    cmdImageConfigDetail: (namespaces, kind, namespace, name) => {
      const no = refusal(s);
      if (no) throw no;
      const found = summary(s, namespaces).workloads.find(
        (w) =>
          w.target.kind === kind &&
          w.target.namespace === namespace &&
          w.target.name === name,
      );
      if (!found)
        throw `${kind} ${namespace}/${name} is no longer in the list; refresh it.`;
      const detail = data(s).details[`${kind}/${namespace}/${name}`];
      return structuredClone(
        detail ?? { workload: found, failed: [], passed: 0 },
      );
    },
    cmdImageConfigSummary: (namespaces, _refresh): ImageConfigList => {
      const no = refusal(s);
      if (no) throw no;
      return {
        summary: summary(s, namespaces),
        read_at: Math.floor(Date.now() / 1000),
      };
    },
  } satisfies AreaHandlers;
}
