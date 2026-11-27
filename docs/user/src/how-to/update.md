# Update or uninstall

## How the app updates itself

The desktop app checks for a newer release when it starts, then about
every 12 hours while it is open, and when your computer wakes up if the last
check is more than 12 hours old. A newer version shows a banner with its
release notes and **Install and restart**; nothing is downloaded until you
click it. The update is verified against the signing key built into the app.

- Turn **Check for updates automatically** off in Settings, or check by hand
  from Settings or the command palette.
- A failed automatic check shows nothing. A banner you close stays closed
  until a newer version comes out.
- The AppImage, the macOS app and the Windows installers update in place.
- A `.deb` installed by hand updates in place only when the release has a
  signed `.deb` update; otherwise the banner links to the release page.
- An install from the apt repository updates with `sudo apt upgrade`.
- On macOS, a copy run straight from the disk image, or from a temporary
  location (App Translocation, when a downloaded app was not moved with
  Finder), can't update itself: the banner says so and links to the release
  page. Drag nauvi into Applications with Finder to update it in place.
- Homebrew: `brew upgrade` leaves the app alone, since it updates itself;
  `brew upgrade --cask --greedy nauvi` updates it anyway.

## Update the CLI

Run the install command again: it installs the latest release over the old
one.

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
```

With Homebrew: `brew upgrade nauvi-cli`. On Windows, run the `-Cli` form of
`install.ps1` again.

## Uninstall

Your settings are kept in every case below, unless the step says otherwise.

**Linux and macOS, installed with the script:** `--uninstall` removes the
app, the CLI, the menu entry and the icons.

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --uninstall
```

**apt:** `curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install-apt.sh | sudo sh -s -- --uninstall`
removes the package, the key and the source. If you added the repository by
hand: `sudo apt remove nauvi`, then delete `/etc/apt/keyrings/nauvi.gpg` and
`/etc/apt/sources.list.d/nauvi.list`.

**Homebrew:** `brew uninstall --cask nauvi` and `brew uninstall nauvi-cli`.
`brew uninstall --zap --cask nauvi` also removes the app's settings and logs.

**Windows:** `-Uninstall`, in the same scriptblock form as `-Cli`, removes the
CLI and its `PATH` entry, and the app too unless `-Cli` is given:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1))) -Uninstall
```

To remove your settings as well, delete the app's folders listed in
[What nauvi stores, and where](../explanations/storage.md).
