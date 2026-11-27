// Image security (`commands/image_security.rs`, #534), from
// `fixtures/image-security.ts` unless a test sets `cluster.imageSecurity`.
// Like the backend, it refuses while image security is off for the
// current context; the tests check that the UI never asks then.

import type { ImageSecurityList, VulnsSummary } from "../../lib/bindings";
import { imageSecurityOn } from "../../lib/imageSecurity";
import { DEFAULT_IMAGE_SECURITY } from "../../lib/imageSecurity";
import { imageSecurityFixture } from "../fixtures/image-security";
import type { FakeImageSecurity } from "../fixtures/image-security";
import type { AreaHandlers, FakeState } from "./state";

const OFF =
  "Image security is off for this cluster. Turn it on in Settings → Image security, or in this cluster's settings.";

function data(s: FakeState): FakeImageSecurity {
  s.cluster.imageSecurity ??= imageSecurityFixture();
  return s.cluster.imageSecurity;
}

function enabled(s: FakeState): boolean {
  const ctx = s.cluster.contexts.find((c) => c.current)?.name ?? "";
  const app = s.cluster.settings.image_security ?? DEFAULT_IMAGE_SECURITY;
  return imageSecurityOn(app, s.cluster.settings.contexts[ctx]?.image_security);
}

function summary(s: FakeState, namespaces: string[]): VulnsSummary {
  const d = data(s);
  const base: VulnsSummary = {
    source: "trivy_operator",
    state: d.state,
    namespace: namespaces.length === 1 ? namespaces[0] : "",
    namespaces_read: [],
    images: [],
    forbidden_namespaces: [],
    all_namespaces_allowed: false,
    unscanned: 0,
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
      all_namespaces_allowed: d.allNamespaces ?? true,
      notes: [],
    };
  }
  const read = namespaces.filter((n) => !forbidden.includes(n));
  const images = d.images.filter(
    (i) => read.length === 0 || i.workloads.some((w) => read.includes(w.namespace)),
  );
  return {
    ...base,
    namespaces_read: namespaces.length > 1 ? read : [],
    forbidden_namespaces: forbidden,
    images: structuredClone(images),
    unscanned: images.filter((i) => !i.scanned).length,
  };
}

export function imageSecurityHandlers(s: FakeState) {
  return {
    cmdImageSecurityImage: (namespaces, image, digest) => {
      if (!enabled(s)) throw OFF;
      const found = summary(s, namespaces).images.find((i) => i.image === image && i.digest === digest);
      if (!found) throw `${image} is no longer in the list; refresh it.`;
      const detail = data(s).details[`${image}@${digest}`];
      return structuredClone(detail ?? { image: found, vulnerabilities: [], fix_groups: [] });
    },
    cmdImageSecuritySummary: (namespaces, _refresh): ImageSecurityList => {
      if (!enabled(s)) throw OFF;
      return { summary: summary(s, namespaces), read_at: Math.floor(Date.now() / 1000) };
    },
  } satisfies AreaHandlers;
}
