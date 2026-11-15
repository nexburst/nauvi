// Kubeconfig sources and context checks (`commands/catalog.rs`).

import { connected } from "../fixtures/catalog";
import { copy, saveSettings } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function catalogHandlers(s: FakeState) {
  const { cluster } = s;
  const addSavedSource = (path: string) =>
    saveSettings(s, { ...cluster.settings, kubeconfig_sources: [...cluster.settings.kubeconfig_sources, path] });
  return {
    cmdKubeconfigSources: () => copy(cluster.catalog.sources),
    // Like the backend: only paths that exist (`catalog.files`), never twice.
    cmdAddKubeconfigSource: (path) => {
      const full = path.trim().replace(/^~(?=\/|$)/, "/home/user");
      if (!full) throw "Type the path of a kubeconfig file or folder.";
      if (cluster.catalog.sources.some((src) => src.path === full)) throw `${full} is already a source.`;
      const found = cluster.catalog.files[full];
      if (!found) throw `cannot add ${full}: No such file or directory (os error 2)`;
      const folder = full.endsWith("/");
      cluster.catalog.sources.push({
        path: full,
        kind: folder ? "folder" : "file",
        contexts: found.length,
        files: 1,
        error: "",
      });
      cluster.contexts.push(...found.map((c) => ({ file: folder ? `${full}config` : full, ...c, source: full })));
      addSavedSource(full);
      return copy(cluster.catalog.sources);
    },
    cmdRemoveKubeconfigSource: (path) => {
      if (!cluster.settings.kubeconfig_sources.includes(path)) {
        throw `${path} was not added in kubeloupe, so it cannot be removed here.`;
      }
      cluster.catalog.sources = cluster.catalog.sources.filter((src) => src.path !== path);
      cluster.contexts = cluster.contexts.filter((c) => c.source !== path);
      saveSettings(s, {
        ...cluster.settings,
        kubeconfig_sources: cluster.settings.kubeconfig_sources.filter((p) => p !== path),
      });
      return copy(cluster.catalog.sources);
    },
    // A kubeconfig is recognised by its first context's name.
    cmdPasteKubeconfig: (yaml, name) => {
      const first = /contexts:\s*\n-\s*name:\s*"?([^"\n]+)"?/.exec(yaml)?.[1]?.trim();
      if (!/kind:\s*Config/.test(yaml) || !first) throw "The pasted text is not a kubeconfig: missing contexts";
      const path = `${cluster.catalog.pastedDir}/${(name.trim() || first).replace(/[^A-Za-z0-9._-]/g, "-")}.yaml`;
      const id = cluster.contexts.some((c) => c.name === first) ? `${first} (${path.split("/").pop()})` : first;
      cluster.catalog.sources.push({ path, kind: "pasted", contexts: 1, files: 1, error: "" });
      cluster.contexts.push({ name: id, context: first, current: false, namespace: null, file: path, source: path });
      addSavedSource(path);
      return copy(cluster.catalog.sources);
    },
    cmdCheckContext: (name) => copy(cluster.catalog.checks[name] ?? connected(name)),
  } satisfies AreaHandlers;
}
