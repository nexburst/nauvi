// Ignores and KEV (`commands/image_triage.rs`, #537). Like the backend,
// the listing and the findings apply the settings' ignores (and the fake
// ignore file's, `FakeImageSecurity.fileRules`) and, while the KEV
// download is on and a catalogue is kept, its ids (`kevIds`).

import type { IgnoreRule_Serialize as IgnoreRule, ImageDetail, ImageVulns, TriageStatus, VulnsSummary } from "../../lib/bindings";
import { DEFAULT_IMAGE_SECURITY } from "../../lib/imageSecurity";
import { ignoreActive, ruleCovers } from "../../lib/imageTriage";
import { imageSecurityFixture } from "../fixtures/image-security";
import type { FakeImageSecurity } from "../fixtures/image-security";
import type { AreaHandlers, FakeState } from "./state";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

function data(s: FakeState): FakeImageSecurity {
  s.cluster.imageSecurity ??= imageSecurityFixture();
  return s.cluster.imageSecurity;
}

const settingsOf = (s: FakeState) => s.cluster.settings.image_security ?? DEFAULT_IMAGE_SECURITY;
const now = () => Math.floor(Date.now() / 1000);

function rules(s: FakeState): IgnoreRule[] {
  const st = settingsOf(s);
  const file = st.ignore_file ? (data(s).fileRules ?? []) : [];
  return [...st.ignores, ...file].filter((r) => ignoreActive(r, now()));
}

function kevIds(s: FakeState): Set<string> {
  const d = data(s);
  return new Set(settingsOf(s).kev_download && d.kevKept ? (d.kevIds ?? []) : []);
}

function ruleFor(s: FakeState, id: string, row: ImageVulns): IgnoreRule | undefined {
  return rules(s).find((r) => r.id.toLowerCase() === id.toLowerCase() && ruleCovers(r, row));
}

/** The row's counts with the ignores taken out, from its full report when the fixture has one. */
function triageRow(s: FakeState, row: ImageVulns): ImageVulns {
  const detail = data(s).details[`${row.image}@${row.digest}`];
  if (!row.scanned || !detail) return row;
  const kev = kevIds(s);
  const out = structuredClone(row);
  for (const v of detail.vulnerabilities) {
    if (ruleFor(s, v.id, row)) {
      out.counts[v.severity] = Math.max(0, out.counts[v.severity] - 1);
      if (v.fixed_version) out.fixable[v.severity] = Math.max(0, out.fixable[v.severity] - 1);
      out.ignored[v.severity] += 1;
    } else if (v.exploit.kev || kev.has(v.id)) {
      out.kev += 1;
    }
  }
  return out;
}

export function triageListing(s: FakeState, summary: VulnsSummary): VulnsSummary {
  const notes = [...summary.notes];
  const st = settingsOf(s);
  const d = data(s);
  if (st.ignore_file && d.fileError) notes.push(d.fileError);
  // Like the backend: Kubescape's summaries name no vulnerabilities, so its
  // rows are triaged once their full report is read.
  const kubescape = summary.images.some((r) => r.source === "kubescape");
  if (kubescape && (rules(s).length > 0 || kevIds(s).size > 0))
    notes.push("Ignores and known exploited vulnerabilities apply to a Kubescape image once you open it.");
  const images = summary.images.map((r) => (r.source === "kubescape" ? r : triageRow(s, r)));
  return { ...summary, notes, images };
}

export function triageDetail(s: FakeState, detail: ImageDetail): ImageDetail {
  const kev = kevIds(s);
  const out: ImageDetail = { ...detail, image: triageRow(s, detail.image), vulnerabilities: [], ignored: [] };
  for (const v of detail.vulnerabilities) {
    const vuln = { ...v, exploit: { ...v.exploit, kev: v.exploit.kev || kev.has(v.id) } };
    const r = ruleFor(s, v.id, detail.image);
    if (r) out.ignored.push({ vulnerability: vuln, reason: r.reason, from_file: r.from_file, expires: r.expires });
    else out.vulnerabilities.push(vuln);
  }
  const ignoredIds = new Set(out.ignored.map((i) => i.vulnerability.id));
  out.fix_groups = detail.fix_groups
    .map((g) => ({ ...g, ids: g.ids.filter((id) => !ignoredIds.has(id)) }))
    .filter((g) => g.ids.length > 0)
    .map((g) => ({
      ...g,
      fixable: out.vulnerabilities.filter((v) => g.ids.includes(v.id) && v.fixed_version).length,
    }));
  return out;
}

function status(s: FakeState): TriageStatus {
  const d = data(s);
  const st = settingsOf(s);
  return {
    file_rules: st.ignore_file && !d.fileError ? (d.fileRules ?? []).length : 0,
    file_error: st.ignore_file ? (d.fileError ?? "") : "",
    file_skipped: [],
    kev_kept: !!d.kevKept,
    kev_version: d.kevKept ? "2026.11.25" : "",
    kev_count: d.kevKept ? (d.kevIds ?? []).length : 0,
    kev_fetched_at: d.kevKept ? (d.kevFetchedAt ?? now() - 7200) : 0,
    kev_url: KEV_URL,
  };
}

export function imageTriageHandlers(s: FakeState) {
  return {
    cmdImageKevUpdate: (): TriageStatus => {
      if (!settingsOf(s).kev_download)
        throw "Downloading the list of known exploited vulnerabilities is off. Turn it on in Settings → Image security first.";
      const d = data(s);
      if (d.kevFail) throw d.kevFail;
      d.kevKept = true;
      d.kevFetchedAt = now();
      return status(s);
    },
    cmdImageTriageStatus: (): TriageStatus => status(s),
  } satisfies AreaHandlers;
}
