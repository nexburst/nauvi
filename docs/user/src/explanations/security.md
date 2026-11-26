# Security model

nauvi is a client: it does what your kubeconfig user may do, and nothing the
user could not. This page explains the extra guards it adds on top, and what
it does not protect against.

## RBAC decides

Every request is made as your kubeconfig user. nauvi asks the API server what
you may do and greys out what you may not, but the API server is what
decides. The CLI and `nauvi mcp` act the same way.

## Read-only and protected contexts

A cluster's Settings can make it **protected** (type the context's name
before any change) or **read-only** (refuse every change, terminals
included). The backend enforces the mode, not only the UI, and `nauvi mcp`
refuses its write tools there. See
[Read-only and protected clusters](../reference/app/modes.md).

## Secrets

- Secret values are hidden in tables, detail panels, the YAML editor and Helm
  manifests until you reveal one; exports and the CLI hide them too, and
  `nauvi mcp` never returns them.
- Secret-looking values in command lines, environment literals and the
  `last-applied-configuration` annotation are masked the same way, as are
  annotations that copy a Secret.
- The app log masks secret-looking text.

## Login commands

A kubeconfig can make nauvi run a program (an exec credential plugin).
Commands from your default kubeconfig run as they do in `kubectl`. Commands
from a kubeconfig you **added** in nauvi are shown first and run only after
you allow them; a changed command asks again. Contexts that send local files
from outside their kubeconfig's folder are checked only when you click Check.
See [Login commands](../reference/app/login-commands.md).

## Terminals and AI

- Local terminals and Ask AI get a temporary kubeconfig with one context,
  readable only by you on Linux and macOS, and deleted afterwards.
- Ask AI runs only a known CLI on your `PATH` or the command you set, never
  through a shell string. The CLI gets a shell and the `nauvi` skill, not a
  read-only tool set: what it runs is up to its own approval prompts.
  Read-only contexts refuse Ask AI; protected ones ask for the name.
- The skill file is written only in the CLI's own skills folder, never
  through a link, and a `SKILL.md` nauvi did not write is never changed.

## Links

A `nauvi://` link only opens a view. It never changes the cluster.

## Downloads and updates

- Install scripts check every file against the release's `SHA256SUMS`.
- In-app updates are verified against the signing key built into the app.
- The apt repository is signed; `install-apt.sh` checks the key's
  fingerprint.
- The macOS and Windows builds are not code-signed yet, which is why macOS
  and SmartScreen warn on first launch.

## The app window

A strict Content Security Policy allows only the app's own files and its IPC:
the window loads nothing from the network.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/nexburst/nauvi/blob/main/SECURITY.md).
