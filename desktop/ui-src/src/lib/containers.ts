import type { EnvInfo, MountInfo, StateInfo } from "./bindings";

/** How a container state is coloured: red for failures, amber for not yet. */
export type Tone = "ok" | "warn" | "bad" | "muted";

/** Waiting reasons that mean something is broken, not just starting. */
export const BAD_WAITING: ReadonlySet<string> = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "PreStartHookError",
  "PostStartHookError",
]);

export function stateTone(s: StateInfo): Tone {
  switch (s.state) {
    case "running":
      return "ok";
    case "waiting":
      return BAD_WAITING.has(s.reason) ? "bad" : "warn";
    case "terminated":
      return s.exit_code === 0 && s.reason !== "OOMKilled" ? "muted" : "bad";
    default:
      return "muted";
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `Waiting: CrashLoopBackOff`, `Terminated: OOMKilled (exit 137)`, `Running`. */
export function stateText(s: StateInfo): string {
  if (!s.state) return "No status yet";
  let text = capital(s.state);
  if (s.reason) text += `: ${s.reason}`;
  if (s.state === "terminated") text += ` (exit ${s.exit_code})`;
  return text;
}

/** `5m ago` / `started 5m ago`, or empty. */
export function stateSince(s: StateInfo): string {
  if (!s.since) return "";
  return s.state === "running" ? `started ${s.since} ago` : `${s.since} ago`;
}

/** `cpu 100m · memory 64Mi`, or `—` when nothing is set. */
export function quantitiesText(q: Partial<Record<string, string>>): string {
  const names = Object.keys(q).sort();
  return names.length ? names.map((n) => `${n} ${q[n]}`).join(" · ") : "—";
}

const SOURCE_KINDS: Record<string, string> = {
  secret: "Secret",
  configmap: "ConfigMap",
  field: "field",
  resource: "resource",
};

/** `secret:db/password` → `Secret db/password`. */
function refText(source: string): string {
  const i = source.indexOf(":");
  if (i < 0) return source;
  const kind = source.slice(0, i);
  return `${SOURCE_KINDS[kind] ?? kind} ${source.slice(i + 1)}`;
}

/** `from Secret db/password`; a literal value shows only that it is set. */
export function envSourceText(source: string): string {
  return source ? `from ${refText(source)}` : "value set";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `3 variables (1 from a Secret) · all of ConfigMap app-cfg`. */
export function envSummary(env: EnvInfo[]): string {
  // `envFrom` entries are named `<prefix>*`: every key of their source.
  const vars = env.filter((e) => !e.name.endsWith("*"));
  const whole = env.filter((e) => e.name.endsWith("*"));
  const parts: string[] = [];
  if (vars.length || !whole.length) {
    const secrets = vars.filter((e) => e.source.startsWith("secret:")).length;
    let text = plural(vars.length, "variable", "variables");
    if (secrets) text += ` (${secrets === 1 ? "1 from a Secret" : `${secrets} from Secrets`})`;
    parts.push(text);
  }
  for (const e of whole) parts.push(`all of ${refText(e.source)}`);
  return parts.join(" · ");
}

/** `/etc/app ← configmap app-cfg (ro)`: the volume's source, else its name. */
export function mountText(m: MountInfo): string {
  const sub = m.sub_path ? ` (subPath ${m.sub_path})` : "";
  return `${m.path} ← ${m.source || m.name}${sub}${m.read_only ? " (ro)" : ""}`;
}

const SAFE = /^[\w@%+=:,./•-]+$/u;

/** argv as a shell line: `sh -c 'echo "hi"; sleep 1'`. */
export function shellJoin(argv: string[]): string {
  return argv.map((a) => (a !== "" && SAFE.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}
