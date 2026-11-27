# Troubleshooting and FAQ

## macOS says "Apple could not verify nauvi"

The app is not signed yet, so macOS blocks it the first time when it came
from a browser download or Homebrew. Click **Done**, then open **System
Settings → Privacy & Security** and click **Open Anyway** next to the nauvi
message. On macOS 15 and later, right-click → Open no longer offers this.

Installing with the script (`curl … install.sh | sh`) avoids the prompt,
because curl sets no quarantine flag.

## macOS says the app is damaged

Run `xattr -dr com.apple.quarantine /Applications/nauvi.app`.

## The nauvi CLI is killed at launch on macOS (exit status 137)

A `nauvi` binary downloaded with a browser carries a quarantine flag. Remove
it: `xattr -d com.apple.quarantine ./nauvi`. The install script and Homebrew
don't need this.

## macOS asks to let nauvi access Photos, Desktop or Documents

A program nauvi started read that folder: your AI CLI, or a command you typed
in a local terminal. macOS asks on behalf of the app that started it. nauvi
itself never reads these folders, so **Don't Allow** is safe. Ask AI runs
its CLI in a folder of its own
([Ask AI](reference/app/ask-ai.md#where-it-runs)), unless you set a working
directory inside one of those folders.

## Windows protected your PC

The builds are not signed yet, so SmartScreen may warn. Click **More info**,
then **Run anyway**.

## The window is blank on Linux

Some GPU drivers leave the window blank. Start the app with
`WEBKIT_DISABLE_DMABUF_RENDERER=1`:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 nauvi-desktop
```

On a machine without a GPU (VMs, remote desktops) nauvi turns WebKitGTK's
DMA-BUF renderer off by itself, which saves about 170 MB; set
`WEBKIT_DISABLE_DMABUF_RENDERER=0` to keep it.

## The AppImage does not start

It needs FUSE 2: `sudo apt install libfuse2t64` on Ubuntu 24.04 and later
(Debian 13), `sudo apt install libfuse2` before.

## A login command fails

Login commands (exec credential plugins for EKS, GKE, AKS…) must be on the
`PATH` nauvi sees. The catalog shows "login failed" with the command's error.

- Run the same `kubectl get ns --context <name>` in a terminal: if it fails
  there too, sign in there first (`aws sso login`, `gcloud auth login`,
  `az login`).
- A context from a kubeconfig you added in nauvi shows its command and runs
  it only after **Allow and check**. "Not allowed" means you chose **Don't
  run**; remove and re-add the source to be asked again.
- For `nauvi mcp` in a desktop AI client, the plugin must log in without a
  prompt: sign in once in a terminal first.

See [Login commands](reference/app/login-commands.md).

## "Cluster unreachable"

nauvi could not reach the API server.

- Check the same context with `kubectl` in a terminal.
- A VPN or proxy may be needed. nauvi ignores `HTTPS_PROXY` from the
  environment for cluster traffic: set `proxy-url` in the kubeconfig or a
  proxy in the cluster's **Settings → Network** ([Use a proxy](how-to/proxy.md)).
- A view retries by itself for about five minutes, then says "Stopped
  retrying." with a **Retry** button (the same as Refresh, `F5`). nauvi also
  tries again by itself when your computer wakes up, when the network or VPN
  comes back, or when you show its window again; time asleep does not count
  toward the five minutes.

## A certificate problem

The catalog shows "certificate problem" when the TLS connection to the API
server fails its certificate checks. nauvi uses the same settings as
`kubectl`: check the cluster's `certificate-authority` (or
`certificate-authority-data`) and the user's client certificate in the
kubeconfig, and try the context with `kubectl`.

## Something is greyed out, or "Not allowed"

Your user may not do that (RBAC). The tooltip names the missing permission.
See [Use a cluster you can only partly read](how-to/limited-access.md).

## The CPU and memory columns are empty

They need metrics-server. The Pods and Nodes tables say so and offer
**Install metrics-server…**, and so does the Overview. Its numbers
appear about a minute after it starts. Maybe **Hide metrics** is on for that
cluster (its **Settings → Metrics**).

## The charts say there is no Prometheus

nauvi finds Prometheus by its usual Service names or the
`app.kubernetes.io/name=prometheus` label, or set its Service in the
cluster's Settings. It needs `get` on `services/proxy` in Prometheus's
namespace ([Metrics](reference/app/metrics.md)).

## A `nauvi://` link does nothing

The AppImage and builds from source do not register the scheme
([Links](reference/app/links.md#which-installs-handle-links)).

## The app does not update itself

A `.deb` installed by hand, a copy run from the macOS disk image, or an app
macOS runs from a temporary location can't. See [Update](how-to/update.md).

## Image security shows nothing

It needs the Trivy Operator in the cluster and permission to list its
reports. Each case has its own message
([Image security](how-to/image-security.md#when-nothing-is-listed)).

## Available tags fails for a registry

Private images need your own `docker login`; some registries do not work
yet ([Which registries work](how-to/image-tags.md#which-registries-work)).

## Where are the logs?

See [Notifications, errors and diagnostics](reference/app/diagnostics.md#the-app-log).
**Report a bug** in the Help menu fills in the version, commit, OS and
webview for you.
