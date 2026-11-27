// Ignores and the KEV catalogue (#537): Settings' status of the ignore file
// and the catalogue, adding and removing ignores, and reading the listing
// again once they change (the backend reads it again when they differ).

import type { IgnoreRule_Serialize as IgnoreRule, TriageStatus } from "../bindings";
import { commands } from "../bindings";
import { sameTarget } from "../imageTriage";
import { imageSecurity, imageSecuritySettings, listedNamespaces, loadImageSecurity, reloadDetail } from "./imageSecurity.svelte";
import { resetFindings } from "./imageFindings.svelte";
import { settingsSaved, updateSettings } from "./settings.svelte";

class ImageTriageStore {
  status = $state.raw<TriageStatus | null>(null);
  downloading = $state(false);
  error = $state("");
}
export const imageTriage = new ImageTriageStore();

/** The ignore file's and the catalogue's state (local files only). */
export async function loadTriageStatus() {
  try {
    imageTriage.status = await commands.cmdImageTriageStatus();
  } catch (e) {
    imageTriage.error = String(e);
  }
}

/** The listing, the surfaces and the panel again, with the new ignores or catalogue. */
export async function triageChanged() {
  await settingsSaved();
  resetFindings();
  if (imageSecurity.list) await loadImageSecurity(listedNamespaces());
  reloadDetail();
}

/** Change the ignore settings, then show their effect. */
async function saveTriage(change: { ignore_file?: string; ignores?: IgnoreRule[]; kev_download?: boolean }) {
  await updateSettings({ image_security: { ...imageSecuritySettings(), ...change } });
  await triageChanged();
}

/** Add `rule` (it replaces an ignore of the same vulnerability and scope). */
export function addIgnore(rule: IgnoreRule) {
  const kept = imageSecuritySettings().ignores.filter((r) => !sameTarget(r, rule));
  return saveTriage({ ignores: [...kept, rule] });
}

export function removeIgnore(rule: IgnoreRule) {
  return saveTriage({ ignores: imageSecuritySettings().ignores.filter((r) => !sameTarget(r, rule)) });
}

export async function setIgnoreFile(path: string) {
  await saveTriage({ ignore_file: path.trim() });
  await loadTriageStatus();
}

/** Turn the KEV download on (downloads now) or off. */
export async function setKevDownload(on: boolean) {
  await updateSettings({ image_security: { ...imageSecuritySettings(), kev_download: on } });
  if (on) await downloadKev();
  else await triageChanged();
}

/** Download the catalogue now. */
export async function downloadKev() {
  imageTriage.downloading = true;
  imageTriage.error = "";
  try {
    await settingsSaved();
    imageTriage.status = await commands.cmdImageKevUpdate();
  } catch (e) {
    imageTriage.error = String(e);
  } finally {
    imageTriage.downloading = false;
  }
  await triageChanged();
}
