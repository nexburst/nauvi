// State of the Image security view (#534): the listing of the namespaces
// shown, and the image whose findings the side panel shows. Nothing is
// asked while image security is off for the cluster, and nothing at all
// until the view (or its panel) is open.

import type { ImageDetail, ImageSecurityList, ImageSecuritySettings_Serialize as ImageSecuritySettings, ImageVulns } from "../bindings";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import { DEFAULT_IMAGE_SECURITY, imageSecurityOn, rowKey } from "../imageSecurity";
import { contextSettings, settings, updateContext } from "./settings.svelte";

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
    const list = await api(visibleCluster()).cmdImageSecuritySummary(namespaces, refresh);
    if (seq !== loadSeq) return;
    imageSecurity.list = list;
    imageSecurity.error = "";
    listedFor = namespaces;
    const still = imageSecurity.selected && list.summary.images.some((r) => rowKey(r) === imageSecurity.selected);
    if (!still) selectImage(null);
    else if (refresh) void loadDetail();
  } catch (e) {
    if (seq !== loadSeq) return;
    imageSecurity.error = String(e);
    imageSecurity.list = null;
  } finally {
    if (seq === loadSeq) imageSecurity.loading = false;
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
  imageSecurity.list = null;
  imageSecurity.loading = false;
  imageSecurity.error = "";
  listedFor = [];
  selectImage(null);
}
