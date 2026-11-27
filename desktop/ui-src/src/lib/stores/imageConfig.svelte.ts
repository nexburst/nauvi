// State of the Configuration tab of the Image security view (#538): the
// workloads of the namespaces shown with their failed checks, and the one
// the side panel shows. Nothing is asked while image security is off for
// the cluster, and nothing until the tab is open.

import type {
  ConfigDetail,
  ImageConfigList,
  WorkloadConfig,
} from "../bindings";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import { configKey, type ImageSecurityTab } from "../imageConfig";

class ImageConfigStore {
  /** The tab the Image security view shows. */
  tab = $state<ImageSecurityTab>("images");
  list = $state.raw<ImageConfigList | null>(null);
  loading = $state(false);
  error = $state("");
  /** `configKey` of the workload the panel shows. */
  selected = $state<string | null>(null);
  detail = $state.raw<ConfigDetail | null>(null);
  detailError = $state("");
  detailLoading = $state(false);
}
export const imageConfig = new ImageConfigStore();

let loadSeq = 0;
let detailSeq = 0;
let listedFor: string[] = [];

onClusterSwitch(() => resetImageConfig());

/** Read the listing of `namespaces`; `refresh` reads the reports again. */
export async function loadImageConfig(namespaces: string[], refresh = false) {
  const seq = ++loadSeq;
  imageConfig.loading = true;
  try {
    const list = await api(visibleCluster()).cmdImageConfigSummary(
      namespaces,
      refresh,
    );
    if (seq !== loadSeq) return;
    imageConfig.list = list;
    imageConfig.error = "";
    const same =
      listedFor.length === namespaces.length &&
      listedFor.every((n, i) => n === namespaces[i]);
    listedFor = namespaces;
    const still =
      same &&
      imageConfig.selected &&
      list.summary.workloads.some((r) => configKey(r) === imageConfig.selected);
    if (!still) selectConfig(null);
    else if (refresh) void loadDetail();
  } catch (e) {
    if (seq !== loadSeq) return;
    imageConfig.error = String(e);
    imageConfig.list = null;
  } finally {
    if (seq === loadSeq) imageConfig.loading = false;
  }
}

/** The selected workload's row in the listing. */
export function selectedConfig(): WorkloadConfig | null {
  const key = imageConfig.selected;
  return (
    imageConfig.list?.summary.workloads.find((r) => configKey(r) === key) ??
    null
  );
}

/** Show `row`'s failed checks in the side panel (`null` closes it). */
export function selectConfig(row: WorkloadConfig | null) {
  detailSeq++;
  imageConfig.selected = row ? configKey(row) : null;
  imageConfig.detail = null;
  imageConfig.detailError = "";
  imageConfig.detailLoading = false;
  if (row) void loadDetail();
}

async function loadDetail() {
  const row = selectedConfig();
  if (!row) return;
  const seq = ++detailSeq;
  imageConfig.detailLoading = true;
  try {
    const t = row.target;
    const detail = await api(visibleCluster()).cmdImageConfigDetail(
      listedFor,
      t.kind,
      t.namespace,
      t.name,
    );
    if (seq !== detailSeq) return;
    imageConfig.detail = detail;
    imageConfig.detailError = "";
  } catch (e) {
    if (seq !== detailSeq) return;
    imageConfig.detailError = String(e);
  } finally {
    if (seq === detailSeq) imageConfig.detailLoading = false;
  }
}

/** Forget the listing (another cluster, or the view closed). The tab stays. */
export function resetImageConfig() {
  loadSeq++;
  imageConfig.list = null;
  imageConfig.loading = false;
  imageConfig.error = "";
  listedFor = [];
  selectConfig(null);
}
