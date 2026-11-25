// The kubectl matching the cluster (`commands/kubectl.rs`, #331).

import type { KubectlMatch } from "../../lib/bindings";
import type { FakeKubectl } from "../fixtures/cluster";
import type { AreaHandlers, FakeState } from "./state";

const DEFAULT: FakeKubectl = { server: "v1.31.2", installed: "v1.28.0", downloaded: false, downloadError: "" };

/** The fake's kubectl state, created on first use. */
export function fakeKubectl(s: FakeState): FakeKubectl {
  s.cluster.kubectl ??= { ...DEFAULT };
  return s.cluster.kubectl;
}

/** Like `nauvi::kubectl_download::MIN_MINOR` (#444). */
const MIN_MINOR = 27;
const minor = (v: string) => Number(v.split(".")[1] ?? NaN);
const tooOld = (v: string) =>
  `the cluster reports ${v}; nauvi only downloads kubectl 1.${MIN_MINOR} or newer ` +
  "(older ones have known security bugs). Your own kubectl is used.";

function match(s: FakeState): KubectlMatch {
  const k = fakeKubectl(s);
  if (!s.cluster.settings.kubectl_match)
    return { enabled: false, server: "", installed: "", skew: false, downloaded: false, url: "", note: "" };
  const skew = !k.installed || Math.abs(minor(k.installed) - minor(k.server)) > 1;
  if (minor(k.server) < MIN_MINOR)
    return {
      enabled: true,
      server: k.server,
      installed: k.installed,
      skew,
      downloaded: false,
      url: "",
      note: skew ? tooOld(k.server) : "",
    };
  return {
    enabled: true,
    server: k.server,
    installed: k.installed,
    skew,
    downloaded: k.downloaded,
    url: `https://dl.k8s.io/release/${k.server}/bin/linux/amd64/kubectl`,
    note: "",
  };
}

export function kubectlHandlers(s: FakeState) {
  return {
    cmdKubectlMatch: () => match(s),
    cmdKubectlDownload: async () => {
      const k = fakeKubectl(s);
      if (!s.cluster.settings.kubectl_match)
        throw 'Turn on "Offer a kubectl that matches the cluster" in Settings first.';
      if (minor(k.server) < MIN_MINOR) throw tooOld(k.server);
      await new Promise((r) => setTimeout(r, 150));
      if (k.downloadError) throw k.downloadError;
      k.downloaded = true;
      return match(s);
    },
  } satisfies AreaHandlers;
}
