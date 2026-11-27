// Image security (`commands/image_security.rs`, #534), from
// `fixtures/image-security.ts` unless a test sets `cluster.imageSecurity`.
// Like the backend, it refuses while image security is off for the
// current context; the tests check that the UI never asks then.

import type { ImageSecurityList, VulnsSummary } from "../../lib/bindings";
import { imageSecurityOn } from "../../lib/imageSecurity";
import { DEFAULT_IMAGE_SECURITY } from "../../lib/imageSecurity";
import { imageSecurityFixture } from "../fixtures/image-security";
import type { FakeImageSecurity } from "../fixtures/image-security";
import { localDetail, localListing } from "./image-scan";
import { triageDetail, triageListing } from "./image-triage";
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

/** The listing with the local scanner's part (#536, `fake/image-scan.ts`). */
export function fakeListing(s: FakeState, namespaces: string[]): VulnsSummary {
  const d = data(s);
  const running = d.images.filter(
    (i) => namespaces.length === 0 || i.workloads.some((w) => namespaces.includes(w.namespace)),
  );
  return triageListing(s, localListing(s, summary(s, namespaces), structuredClone(running)));
}

export function imageSecurityHandlers(s: FakeState) {
  return {
    cmdImageSecurityImage: (namespaces, image, digest) => {
      if (!enabled(s)) throw OFF;
      const found = fakeListing(s, namespaces).images.find((i) => i.image === image && i.digest === digest);
      if (!found) throw `${image} is no longer in the list; refresh it.`;
      if (found.source === "local_scanner" && found.scanned) return localDetail(s, found);
      const detail = data(s).details[`${image}@${digest}`];
      if (!detail) return { image: found, vulnerabilities: [], fix_groups: [], ignored: [] };
      if (found.source !== "kubescape") return triageDetail(s, structuredClone(detail));
      // Like the backend: the listing's row (already triaged after an
      // earlier open) is rebuilt from the full report, then kept (#537).
      const zero = () => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
      const base = { ...structuredClone(found), counts: zero(), fixable: zero(), ignored: zero(), kev: 0, fixes_known: true };
      for (const v of detail.vulnerabilities) {
        base.counts[v.severity] += 1;
        if (v.fixed_version) base.fixable[v.severity] += 1;
      }
      const out = triageDetail(s, { ...structuredClone(detail), image: base });
      const d = data(s);
      d.images = d.images.map((r) => (r.image === image && r.digest === digest ? structuredClone(out.image) : r));
      return out;
    },
    cmdImageSecuritySummary: (namespaces, _refresh): ImageSecurityList => {
      if (!enabled(s)) throw OFF;
      return { summary: fakeListing(s, namespaces), read_at: Math.floor(Date.now() / 1000) };
    },
  } satisfies AreaHandlers;
}
