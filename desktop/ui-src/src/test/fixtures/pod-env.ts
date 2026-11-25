// What `cmd_pod_env` returns for the fake pods (#447), by
// `namespace/pod/container`. Secret values are never here (the backend
// never sends them): revealing one reads the fake Secret's data. Literals
// that look like secrets arrive hidden; `POD_ENV_LITERALS` has their values.

import type { ContainerEnv, EnvValue } from "../../lib/bindings";

const v = (r: Partial<EnvValue> & { name: string }): EnvValue => ({
  kind: "literal",
  object: "",
  key: "",
  value: "",
  hidden: false,
  error: "",
  overridden: false,
  ...r,
});

export const POD_ENV: Record<string, ContainerEnv> = {
  "demo/web-1/app": {
    container: "app",
    from: [
      {
        kind: "configmap",
        object: "settings",
        prefix: "CFG_",
        optional: false,
        error: "",
        rows: [
          v({ name: "CFG_app.conf", kind: "configmap", object: "settings", key: "app.conf", value: "a=1\nb=2" }),
          v({ name: "CFG_mode", kind: "configmap", object: "settings", key: "mode", value: "dev", overridden: true }),
          // A ConfigMap value that looks like a secret: hidden like a literal.
          v({ name: "CFG_secret_token", kind: "configmap", object: "settings", key: "secret_token", hidden: true }),
        ],
      },
      {
        kind: "secret",
        object: "api-keys",
        prefix: "",
        optional: false,
        error: "not allowed to read Secret api-keys in demo",
        rows: [],
      },
    ],
    env: [
      v({ name: "MODE", value: "production" }),
      v({ name: "DB_PASSWORD", kind: "secret", object: "db-creds", key: "password", hidden: true }),
      v({ name: "API_TOKEN", hidden: true }),
      v({ name: "LOG_LEVEL", kind: "configmap", object: "settings", key: "mode", value: "dev" }),
      v({ name: "FEATURE", kind: "configmap", object: "flags", key: "beta", error: "ConfigMap flags not found" }),
      v({ name: "POD_NAME", kind: "field", key: "metadata.name", value: "web-1" }),
      v({ name: "CPU_LIMIT", kind: "resource", key: "limits.cpu" }),
      v({
        name: "JAVA_OPTS",
        value: "-Xms256m -Xmx512m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -Dfile.encoding=UTF-8 -Duser.timezone=UTC",
      }),
      v({ name: "CFG_mode", value: "override" }),
      // A right-to-left override (U+202E) and a zero-width space: shown escaped.
      v({ name: "TRICKY", value: "abc\u202Edef\u200Bghi" }),
    ],
  },
};

/** The hidden literal values, by `namespace/pod/container/name`. */
export const POD_ENV_LITERALS: Record<string, string> = {
  "demo/web-1/app/API_TOKEN": "tok-123-literal",
  "demo/web-1/app/CFG_secret_token": "cm-tok-777",
};
