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
        throw `${path} was not added in nauvi, so it cannot be removed here.`;
      }
      cluster.catalog.sources = cluster.catalog.sources.filter((src) => src.path !== path);
      for (const key of Object.keys(cluster.catalog.answers)) {
        if (key.startsWith(`${path}\n`)) delete cluster.catalog.answers[key];
      }
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
      // `command:` and `args:` of an exec user become its login command.
      const command = /exec:[\s\S]*?command:\s*(\S+)/.exec(yaml)?.[1] ?? "";
      const args = /exec:[\s\S]*?args:\s*\[([^\]]*)\]/.exec(yaml)?.[1] ?? "";
      const login = [command, ...args.split(",").map((a) => a.trim().replace(/^"|"$/g, ""))]
        .filter(Boolean)
        .join(" ");
      // Absolute file references outside the pasted files' folder (#244).
      const localFiles = [...yaml.matchAll(/(?:tokenFile|client-certificate|client-key):\s*"?(\/[^"\s]+)/g)]
        .map((m) => m[1])
        .filter((f) => !f.startsWith(`${cluster.catalog.pastedDir}/`));
      cluster.contexts.push({
        name: id,
        context: first,
        current: false,
        namespace: null,
        file: path,
        source: path,
        login_command: command ? login : "",
        login_plugin: !!command,
        local_files: localFiles,
      });
      addSavedSource(path);
      return copy(cluster.catalog.sources);
    },
    cmdCheckContext: (name, asked) => {
      // Like the backend: an added source's login command runs only once allowed.
      const ctx = cluster.contexts.find((c) => c.name === name);
      // ... and its local files outside its folder are sent only when asked (#244).
      if (ctx?.source && ctx.local_files?.length && !asked) {
        return {
          name,
          state: "local_files" as const,
          message: `Not checked: logging in to \`${name}\` sends local files from outside its kubeconfig's folder (${ctx.local_files.join(", ")}). Choose Check to check it.`,
          version: "",
        };
      }
      if (ctx?.source && ctx.login_command) {
        const answer = cluster.catalog.answers[`${ctx.source}\n${ctx.login_command}`];
        if (answer !== true) {
          const why = answer === false ? "you chose not to run it" : "you have not allowed it yet";
          return {
            name,
            state: "not_allowed" as const,
            message: `Login to \`${name}\` was not started: it runs \`${ctx.login_command}\` (from ${ctx.source}), and ${why}. Open the cluster catalog and choose Check to allow it.`,
            version: "",
          };
        }
      }
      if (ctx?.login_plugin) cluster.catalog.pluginRuns[name] = (cluster.catalog.pluginRuns[name] ?? 0) + 1;
      return copy(cluster.catalog.checks[name] ?? connected(name));
    },
    cmdExecCommands: (source) => {
      const out: { command: string; contexts: string[]; answer: "unanswered" | "allowed" | "denied" }[] = [];
      for (const c of cluster.contexts.filter((c) => c.source === source && c.login_command)) {
        const found = out.find((e) => e.command === c.login_command);
        if (found) {
          found.contexts.push(c.name);
          continue;
        }
        const answer = cluster.catalog.answers[`${source}\n${c.login_command}`];
        out.push({
          command: c.login_command ?? "",
          contexts: [c.name],
          answer: answer === undefined ? "unanswered" : answer ? "allowed" : "denied",
        });
      }
      return out;
    },
    cmdAnswerExecCommand: (source, command, allow) => {
      cluster.catalog.answers[`${source}\n${command}`] = allow;
      return null;
    },
  } satisfies AreaHandlers;
}
