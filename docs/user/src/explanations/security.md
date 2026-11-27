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
- Ask AI runs its CLI in a folder of its own, readable only by you on Linux
  and macOS, not in your home folder.
- **Let Ask AI open views** (off by default) lets the AI open panels and
  tables with `nauvi show`, at most one every 3 seconds; it never runs an
  action.

## Links

A `nauvi://` link only opens a view. It never changes the cluster.

## Container images

- **Available tags** (off by default) asks an image's registry only when
  you click, over HTTPS only. It refuses loopback, link-local and cloud
  metadata addresses, also when a registry's name resolves to one, and
  follows redirects only on the same host. It signs in with your own
  `docker login`, never with the cluster's image pull secrets, and sends
  those credentials only to the registry's own host or its parent domain (and auth.docker.io
  for Docker Hub)
  ([Find a newer tag](../how-to/image-tags.md)).
- **Image security** (off by default) reads the Trivy Operator's (or
  Kubescape's) reports with your own access
  ([Image security](../how-to/image-security.md)). nauvi downloads nothing
  for it, except CISA's list of known exploited vulnerabilities when you
  turn that on: one public file from `www.cisa.gov` over https, once a day,
  with nothing about your clusters or images sent.
- **A scanner on this computer** (off by default) is a Trivy or Grype you
  installed. nauvi never downloads one, and runs the file only after you
  approve it, by its size and SHA-256; a changed file is asked about again.
  Trivy 0.69.4 to 0.69.6, malicious releases, are refused without being
  run. nauvi turns off Trivy's telemetry and the scanners' update checks.
  The scanner pulls images by digest with your own `docker login`, never
  the cluster's pull secrets, and scans only when you click
  ([Scan with your own Trivy or Grype](../how-to/image-security.md#scan-with-your-own-trivy-or-grype)).

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
