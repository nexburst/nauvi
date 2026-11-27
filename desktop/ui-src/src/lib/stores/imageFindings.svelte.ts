// The image security listing for the surfaces outside the view (#535): the
// Vulns column, the workload's Security tab, the container cards, the
// Overview card and "Copy as prompt". One listing for the namespaces
// shown, the same `cmdImageSecuritySummary` the view asks for: the backend
// answers it from its cache (`cache_ttl_hours`), and a listing the view
// read is shared here. Nothing is asked while image security is off for
// the cluster, and nothing until a surface needs it.

import { untrack } from "svelte";
import type { ImageSecurityList, ImageVulns } from "../bindings";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import { buildIndex, type FindingsIndex } from "../imageFindings";
import { IMAGE_SECURITY_VIEW, rowKey } from "../imageSecurity";
import { setVulnsSource } from "../vulnsColumn";
import { app, currentContextName, setView } from "./app.svelte";
import { imageSecurityEnabled, imageSecuritySettings, selectOnLoad } from "./imageSecurity.svelte";

class FindingsStore {
  list = $state.raw<ImageSecurityList | null>(null);
  /** The namespaces `list` is for, sorted (empty: all). */
  namespaces = $state.raw<string[]>([]);
}
export const findings = new FindingsStore();

let seq = 0;
let pending: { key: string; promise: Promise<void> } | null = null;

onClusterSwitch(() => resetFindings());

const sortedKey = (namespaces: readonly string[]) => [...new Set(namespaces.filter(Boolean))].sort().join(",");

/** Whether the surfaces show findings for the cluster on screen. */
export function findingsOn(): boolean {
  return imageSecurityEnabled(currentContextName());
}

/** The listing of the namespaces shown, read (or taken from the backend's
 *  cache) once; again only when the namespaces change. */
export function ensureFindings(namespaces: readonly string[] = app.selectedNamespaces): Promise<void> {
  if (!findingsOn()) return Promise.resolve();
  const key = sortedKey(namespaces);
  if (findings.list && sortedKey(findings.namespaces) === key) return Promise.resolve();
  if (pending?.key === key) return pending.promise;
  const mine = ++seq;
  const ns = [...namespaces];
  const promise = api(visibleCluster())
    .cmdImageSecuritySummary(ns, false)
    .then((list) => {
      if (mine !== seq) return;
      findings.list = list;
      findings.namespaces = ns;
    })
    .catch(() => {
      // Nothing to show: the view says why (off, not allowed, no operator).
      if (mine === seq) findings.list = null;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { key, promise };
  return promise;
}

/** For a component: keep the listing for the namespaces shown while it is
 *  mounted (call during the component's initialisation). */
export function useFindings() {
  $effect(() => {
    if (!findingsOn()) return;
    const namespaces = [...app.selectedNamespaces];
    untrack(() => void ensureFindings(namespaces));
  });
}

/** A listing the view read (or read again) is the surfaces' too. */
export function shareFindings(list: ImageSecurityList, namespaces: readonly string[]) {
  seq++;
  pending = null;
  findings.list = list;
  findings.namespaces = [...namespaces];
}

let memo: { list: ImageSecurityList; excluded: string; index: FindingsIndex } | null = null;

/** The listing joined by workload and image, `null` while off or not read. */
export function findingsIndex(): FindingsIndex | null {
  if (!findingsOn()) return null;
  const list = findings.list;
  if (!list || list.summary.state !== "ok") return null;
  const s = imageSecuritySettings();
  const excluded = s.excluded_namespaces.join("\n");
  if (memo?.list !== list || memo.excluded !== excluded) memo = { list, excluded, index: buildIndex(list.summary.images, s) };
  return memo.index;
}

/** The listing's images (for the Overview card), `null` while off or not read. */
export function findingsImages(): readonly ImageVulns[] | null {
  if (!findingsOn()) return null;
  const list = findings.list;
  return list && list.summary.state === "ok" ? list.summary.images : null;
}

/** The namespaces of the listing, for reading one image's full report. */
export function findingsNamespaces(): string[] {
  return [...findings.namespaces];
}

/** Show `row`'s findings in the Image security view. */
export function openImageFindings(row: ImageVulns) {
  selectOnLoad(rowKey(row));
  setView(IMAGE_SECURITY_VIEW);
}

// The Vulns column reads the listing through this.
setVulnsSource({ on: findingsOn, index: findingsIndex, settings: imageSecuritySettings });

export function resetFindings() {
  seq++;
  pending = null;
  memo = null;
  findings.list = null;
  findings.namespaces = [];
}
