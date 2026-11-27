// State of the Image security view (#534): the listing of the namespaces
// shown, and the image whose findings the side panel shows. Nothing is
// asked while image security is off for the cluster, and nothing at all
// until the view (or its panel) is open.

import type { ImageDetail, ImageSecurityList, ImageSecuritySettings_Serialize as ImageSecuritySettings, ImageVulns } from "../bindings";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import { DEFAULT_IMAGE_SECURITY, imageSecurityOn, rowKey } from "../imageSecurity";
import { contextSettings, settings, settingsSaved, updateContext } from "./settings.svelte";
import { shareFindings } from "./imageFindings.svelte";

class ImageSecurityStore {
  list = $state.raw<ImageSecurityList | null>(null);
  loading = $state(false);
  error = $state("");
  /** `rowKey` of the image the panel shows. */
  selected = $state<string | null>(null);
  detail = $state.raw<ImageDetail | null>(null);
  detailError = $state("");
  detailLoading = $state(false);
}
export const imageSecurity = new ImageSecurityStore();

/** Each load's number: an answer for an older one is dropped. */
let loadSeq = 0;
let detailSeq = 0;
/** The namespaces of the shown listing, for the panel's request. */
let listedFor: string[] = [];
/** Bumped by `resetImageSecurity` (another cluster, Source or Scanner):
 *  a scan started before it can't patch the listing that follows. */
let generation = 0;
/** `rowKey` of an image to show once the view has its listing (#535). */
let showOnLoad: string | null = null;

/** Open `key`'s findings in the view's panel once the view lists it. */
export function selectOnLoad(key: string) {
  showOnLoad = key;
}

onClusterSwitch(() => resetImageSecurity());

/** The settings of the section (older settings may have none). */
export function imageSecuritySettings(): ImageSecuritySettings {
  return settings.current.image_security ?? DEFAULT_IMAGE_SECURITY;
}

/** Whether the reports are read for cluster `context`. */
export function imageSecurityEnabled(context: string): boolean {
  return imageSecurityOn(imageSecuritySettings(), contextSettings(context).image_security);
}

/** Turn it on (or back to the app's setting) for one cluster. */
export function setClusterImageSecurity(context: string, mode: "default" | "on" | "off") {
  return updateContext(context, { image_security: mode });
}

/** Read the listing of `namespaces`; `refresh` reads the reports again. */
export async function loadImageSecurity(namespaces: string[], refresh = false) {
  const seq = ++loadSeq;
  imageSecurity.loading = true;
  try {
    // A Source or Scanner just changed: read with what the backend has.
    await settingsSaved();
    if (seq !== loadSeq) return;
    const list = await api(visibleCluster()).cmdImageSecuritySummary(namespaces, refresh);
    if (seq !== loadSeq) return;
    imageSecurity.list = list;
    imageSecurity.error = "";
    shareFindings(list, namespaces);
    // Other namespaces: the panel was about another list.
    const same = listedFor.length === namespaces.length && listedFor.every((n, i) => n === namespaces[i]);
    listedFor = namespaces;
    const still = same && imageSecurity.selected && list.summary.images.some((r) => rowKey(r) === imageSecurity.selected);
    const asked = showOnLoad ? list.summary.images.find((r) => rowKey(r) === showOnLoad) : undefined;
    showOnLoad = null;
    if (asked) selectImage(asked);
    else if (!still) selectImage(null);
    else if (refresh) void loadDetail();
  } catch (e) {
    if (seq !== loadSeq) return;
    imageSecurity.error = String(e);
    imageSecurity.list = null;
  } finally {
    if (seq === loadSeq) imageSecurity.loading = false;
  }
}

/** The namespaces of the shown listing (a scan names its image in it). */
export function listedNamespaces(): string[] {
  return listedFor;
}

/** The listing's generation, for `patchImage`. */
export function imageListGeneration(): number {
  return generation;
}

/** Put a scan's row (#536) in the listing, and its findings in the panel
 *  when it is the one shown. `gen`: `imageListGeneration()` when the scan
 *  started; a scan from before a reset is dropped. */
export function patchImage(detail: ImageDetail, gen: number) {
  if (gen !== generation) return;
  const list = imageSecurity.list;
  if (!list) return;
  const key = rowKey(detail.image);
  const images = list.summary.images.map((r) => (rowKey(r) === key ? detail.image : r));
  const patched = { ...list, summary: { ...list.summary, images, unscanned: images.filter((r) => !r.scanned).length } };
  imageSecurity.list = patched;
  // The Vulns column, Security tab, cards and Overview show it too.
  shareFindings(patched, listedFor);
  if (imageSecurity.selected === key) {
    detailSeq++;
    imageSecurity.detail = detail;
    imageSecurity.detailError = "";
    imageSecurity.detailLoading = false;
  }
}

/** The selected image's row in the listing. */
export function selectedImage(): ImageVulns | null {
  const key = imageSecurity.selected;
  return imageSecurity.list?.summary.images.find((r) => rowKey(r) === key) ?? null;
}

/** Show `row`'s findings in the side panel (`null` closes it). */
export function selectImage(row: ImageVulns | null) {
  detailSeq++;
  imageSecurity.selected = row ? rowKey(row) : null;
  imageSecurity.detail = null;
  imageSecurity.detailError = "";
  imageSecurity.detailLoading = false;
  if (row) void loadDetail();
}

async function loadDetail() {
  const row = selectedImage();
  if (!row) return;
  const seq = ++detailSeq;
  imageSecurity.detailLoading = true;
  try {
    const detail = await api(visibleCluster()).cmdImageSecurityImage(listedFor, row.image, row.digest);
    if (seq !== detailSeq) return;
    imageSecurity.detail = detail;
    imageSecurity.detailError = "";
  } catch (e) {
    if (seq !== detailSeq) return;
    imageSecurity.detailError = String(e);
  } finally {
    if (seq === detailSeq) imageSecurity.detailLoading = false;
  }
}

/** The panel's findings again (the severity or "only fixable" changed). */
export function reloadDetail() {
  if (imageSecurity.selected) void loadDetail();
}

/** Forget everything (another cluster, or the view closed). */
export function resetImageSecurity() {
  loadSeq++;
  generation++;
  imageSecurity.list = null;
  imageSecurity.loading = false;
  imageSecurity.error = "";
  listedFor = [];
  selectImage(null);
}
