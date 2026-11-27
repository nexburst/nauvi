// The local scanner (#536, ADR 0011): its status in Settings, and the
// scans the user starts. One scan at a time; "Scan all" scans the images
// of the listing one after another, only from a click, and Cancel stops
// the one that runs (the backend kills the scanner) and the rest.

import { commands } from "../bindings";
import type { ImageVulns, ScannerKind, ScannerStatus } from "../bindings";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import { rowKey } from "../imageSecurity";
import { imageListGeneration, imageSecuritySettings, listedNamespaces, patchImage } from "./imageSecurity.svelte";

class ImageScanStore {
  status = $state.raw<ScannerStatus | null>(null);
  statusError = $state("");
  statusLoading = $state(false);
  /** `rowKey` and image of the scan that runs. */
  running = $state.raw<{ key: string; image: string } | null>(null);
  /** A "Scan all": where it is. */
  batch = $state.raw<{ done: number; total: number } | null>(null);
  /** The failures of the last scans, by `rowKey`. */
  errors = $state.raw<Map<string, { image: string; error: string }>>(new Map());
}
export const imageScan = new ImageScanStore();

let cancelled = false;
let statusSeq = 0;

onClusterSwitch(() => {
  if (imageScan.running) void cancelScan();
  imageScan.errors = new Map();
});

/** The scanner of the settings (`scanner`: another one than saved). */
export async function loadScannerStatus(scanner?: ScannerKind) {
  const seq = ++statusSeq;
  imageScan.statusLoading = true;
  try {
    const s = await commands.cmdImageScannerStatus(scanner ?? imageSecuritySettings().scanner);
    if (seq !== statusSeq) return;
    imageScan.status = s;
    imageScan.statusError = "";
  } catch (e) {
    if (seq !== statusSeq) return;
    imageScan.status = null;
    imageScan.statusError = String(e);
  } finally {
    if (seq === statusSeq) imageScan.statusLoading = false;
  }
}

/** Approve the binary the status shows, by the SHA-256 it showed: a
 *  file changed since is refused by the backend. */
export async function approveScanner() {
  const s = imageScan.status;
  if (!s || !s.path) return;
  const seq = ++statusSeq;
  imageScan.statusLoading = true;
  try {
    const next = await commands.cmdImageScannerApprove(s.scanner, s.path, s.sha256);
    if (seq !== statusSeq) return;
    imageScan.status = next;
    imageScan.statusError = "";
  } catch (e) {
    if (seq !== statusSeq) return;
    imageScan.statusError = String(e);
  } finally {
    if (seq === statusSeq) imageScan.statusLoading = false;
  }
}

export async function forgetScanner() {
  const s = imageScan.status;
  if (!s) return;
  const seq = ++statusSeq;
  try {
    const next = await commands.cmdImageScannerForget(s.scanner);
    if (seq === statusSeq) imageScan.status = next;
  } catch (e) {
    if (seq === statusSeq) imageScan.statusError = String(e);
  }
}

function setError(key: string, image: string, error: string | null) {
  const next = new Map(imageScan.errors);
  if (error === null) next.delete(key);
  else next.set(key, { image, error });
  imageScan.errors = next;
}

/** Scan one image; `refresh` scans again although a scan is kept. */
async function scanOne(row: ImageVulns, refresh: boolean, gen: number): Promise<boolean> {
  const key = rowKey(row);
  imageScan.running = { key, image: row.image };
  try {
    const detail = await api(visibleCluster()).cmdImageScan(listedNamespaces(), row.image, row.digest, refresh);
    // The listing was reset (Source, Scanner or cluster) while it ran.
    if (gen !== imageListGeneration()) return false;
    setError(key, row.image, null);
    patchImage(detail, gen);
    return true;
  } catch (e) {
    if (gen !== imageListGeneration()) return false;
    setError(key, row.image, String(e));
    return false;
  } finally {
    imageScan.running = null;
  }
}

/** Scan `row` (from its panel). */
export async function scanImage(row: ImageVulns, refresh = false) {
  if (imageScan.running) return;
  cancelled = false;
  await scanOne(row, refresh, imageListGeneration());
}

/** Scan `rows` one after another (the "Scan all" button). */
export async function scanAll(rows: readonly ImageVulns[]) {
  if (imageScan.running || rows.length === 0) return;
  cancelled = false;
  imageScan.errors = new Map();
  imageScan.batch = { done: 0, total: rows.length };
  const gen = imageListGeneration();
  try {
    for (let i = 0; i < rows.length; i++) {
      if (cancelled || gen !== imageListGeneration()) break;
      imageScan.batch = { done: i, total: rows.length };
      await scanOne(rows[i], false, gen);
    }
  } finally {
    imageScan.batch = null;
  }
}

/** Stop the scan that runs and the ones after it. */
export async function cancelScan() {
  cancelled = true;
  await commands.cmdImageScanCancel();
}
