# nexburst/homebrew-tap

Homebrew packages for [nauvi](https://github.com/nexburst/nauvi), a
Kubernetes IDE written in Rust.

```sh
brew install --cask nexburst/tap/nauvi   # the desktop app (universal .dmg)
brew install nexburst/tap/nauvi-cli      # the CLI, with bash, zsh and fish completions
```

The CLI formula also works with Homebrew on Linux (x86_64).

If Homebrew refuses to load a package from an untrusted tap (Homebrew 7
and later), trust this one first: `brew trust nexburst/tap`.

## The desktop app is not signed yet

macOS blocks the app the first time you open it, the same as when you
install the .dmg yourself. Open it once, then go to System Settings >
Privacy & Security and click **Open Anyway** next to the message about
nauvi. On macOS 15 and later, right-click > Open no longer does this.

## Updates

The app updates itself (the cask is `auto_updates true`), so `brew upgrade`
leaves it alone; `brew upgrade --greedy` or `brew upgrade --cask nauvi`
updates it anyway. The CLI updates with `brew upgrade`.

`brew uninstall --zap --cask nauvi` also removes the app's settings, logs and
caches (`~/Library/Application Support/com.nauvi.app` and friends).

## How this repository is updated

Don't edit `Casks/nauvi.rb` or `Formula/nauvi-cli.rb` here. They are rendered
from the templates in
[`packaging/homebrew/`](https://github.com/nexburst/nauvi/tree/main/packaging/homebrew)
of nexburst/nauvi by `scripts/release/homebrew.sh`, and the release workflow
pushes them here after each release. The CI here runs `brew style`,
`brew audit` and installs both packages on every push.

Problems with nauvi itself go to
[nexburst/nauvi issues](https://github.com/nexburst/nauvi/issues).
