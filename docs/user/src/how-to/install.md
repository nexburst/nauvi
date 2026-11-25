# Install nauvi

This page installs the desktop app, the `nauvi` CLI, or both. They are
separate installs. On Linux the app's command is `nauvi-desktop` and the
CLI's is `nauvi`, so both fit in the same folder.

Every install script downloads the latest release and checks each file
against the release's `SHA256SUMS` before it installs anything.

## Linux (x86_64)

The desktop app:

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh
```

Only the CLI (`nauvi`):

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
```

The script needs no sudo. It installs:

- the app: the AppImage as `~/.local/bin/nauvi-desktop`, a menu entry
  (`~/.local/share/applications/nauvi.desktop`) that also opens `nauvi://`
  links, and its icon. The app updates itself.
- the CLI: `~/.local/bin/nauvi`.

The AppImage needs FUSE 2. If it is missing, the script prints the package to
install and does not install it itself: `sudo apt install libfuse2t64` on
Ubuntu 24.04 and later (Debian 13), `sudo apt install libfuse2` before. It
also warns when `~/.local/bin` is not on your `PATH`.

Options, put before `sh` (`curl … | NAUVI_VERSION=v0.1.0 sh`):

- `NAUVI_VERSION=v0.1.0` installs that release instead of the latest.
- `NAUVI_INSTALL_DIR` (an absolute path) replaces `~/.local/bin`.

Other architectures (arm64) have no build yet.

If the window stays blank, see
[Troubleshooting](../troubleshooting.md#the-window-is-blank-on-linux).

### With apt (Debian, Ubuntu)

The desktop app is also in a signed apt repository, so `sudo apt upgrade`
keeps it up to date. One command adds the repository and installs nauvi:

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install-apt.sh | sudo sh
```

The script fetches the repository's key and refuses it unless its
fingerprint is `B2B644E79A85C438FC3EB8C5408A65C769395FBF`. Then it writes
`/etc/apt/keyrings/nauvi.gpg` and `/etc/apt/sources.list.d/nauvi.list` and
runs `apt install nauvi`, installing `gpg` and `curl` first if they are
missing.

The package is the desktop app (`/usr/bin/nauvi-desktop` and a menu entry),
the same `.deb` as on the Releases page. The repository has only that
package, for x86_64. The CLI is not in it yet: use the script above with
`--cli`.

<details>
<summary>The same steps by hand</summary>

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://nexburst.github.io/nauvi/apt/nauvi.gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nauvi.gpg
gpg --show-keys /etc/apt/keyrings/nauvi.gpg   # must show B2B644E79A85C438FC3EB8C5408A65C769395FBF
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/nauvi.gpg] https://nexburst.github.io/nauvi/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nauvi.list
sudo apt update
sudo apt install nauvi
```

If the fingerprint is different, delete both files and don't install.

</details>

### By hand

From the [Releases page](https://github.com/nexburst/nauvi/releases):

- `.deb`: `sudo apt install ./nauvi_*_amd64.deb`. It installs
  `/usr/bin/nauvi-desktop` and a menu entry.
- `.AppImage`: `chmod +x nauvi_*_amd64.AppImage` and run it.
- The CLI: `nauvi-cli-v<version>-x86_64-unknown-linux-gnu.tar.gz` holds the
  `nauvi` binary.

## macOS (Apple silicon and Intel)

The same script works on macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
```

The first installs `nauvi.app` from the universal `.dmg` into
`/Applications` (or `~/Applications` when `/Applications` is not writable;
`NAUVI_APP_DIR` changes it). The second installs the CLI as
`~/.local/bin/nauvi`. The script downloads with curl, which sets no
quarantine flag, so macOS opens the app without asking.

### With Homebrew

```sh
brew install --cask nexburst/tap/nauvi
brew install nexburst/tap/nauvi-cli
```

The first is the desktop app, the second the CLI, with bash, zsh and fish
completions. Homebrew 6 and later refuse to load packages from a tap you
have not trusted; run `brew trust nexburst/tap` first if it asks. The CLI
formula works with Homebrew on Linux (x86_64) too.

The app updates itself, so `brew upgrade` leaves it alone
(`brew upgrade --cask --greedy nauvi` updates it anyway).

### By hand

Download the universal `.dmg`, or the CLI as
`nauvi-cli-v<version>-aarch64-apple-darwin.tar.gz` (Apple silicon) or
`nauvi-cli-v<version>-x86_64-apple-darwin.tar.gz` (Intel). Open the `.dmg`
and drag the app to Applications in Finder. Don't run it from the disk image:
macOS then runs it from a temporary read-only copy, which can't update
itself.

### The first launch: "Open Anyway"

The app is not signed yet, so macOS blocks it the first time when it came
from a browser download or Homebrew. The first launch says "Apple could not
verify…". Click **Done**, then open **System Settings → Privacy & Security**
and click **Open Anyway** next to the nauvi message. On macOS 15 and later,
right-click → Open no longer offers this.

If macOS says the app is damaged, run
`xattr -dr com.apple.quarantine /Applications/nauvi.app`. A `nauvi` CLI
binary downloaded with a browser is killed at launch (exit status 137) until
you remove its quarantine flag: `xattr -d com.apple.quarantine ./nauvi`.
After the install script, neither step should be needed.

## Windows (x64)

In PowerShell, the desktop app:

```powershell
irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1 | iex
```

Only the CLI:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1))) -Cli
```

The script checks the download against `SHA256SUMS` like the Linux one. The
app comes from the `.msi` (`msiexec /passive`; Windows asks for permission)
and updates itself. The CLI goes to `%LOCALAPPDATA%\nauvi\bin\nauvi.exe`,
which is added to your user `PATH`; open a new terminal to use it. Run the
script again to upgrade.

Options: `$env:NAUVI_CLI = '1'` before the `| iex` form does the same as
`-Cli`; `NAUVI_VERSION` and `NAUVI_INSTALL_DIR` work as on Linux.

To download by hand: the `.msi`, the NSIS `-setup.exe`, or the CLI as
`nauvi-cli-v<version>-x86_64-pc-windows-msvc.zip`. The builds are not signed
yet, so SmartScreen may show "Windows protected your PC": click **More
info**, then **Run anyway**.

## Check a download

Every release has a `SHA256SUMS` file. Check what you downloaded with:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

That protects against a broken or swapped download, not against a
compromised release, since the file comes from the same place. Each release
also ships CycloneDX SBOMs (`nauvi-<tag>-*.cdx.json`) and is scanned for
known vulnerabilities with Grype.

## Next

- [Get started](../get-started.md).
- [Update or uninstall](update.md).
- Behind a proxy? See [Use a proxy](proxy.md).
