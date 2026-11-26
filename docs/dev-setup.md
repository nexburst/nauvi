# Developer machine setup (and recovery)

How to get a machine from nothing to "agents can build, test and QA nauvi".
Use it for a new laptop or to recover after losing one. Everything that matters
long term lives in GitHub (code, issues, PRs, the roadmap #24, the release gate
#84, `CLAUDE.md`, `.claude/agents/`); this page covers the local pieces.

## 1. Tools

Linux (Ubuntu/Debian) is the main development platform.

- Git, the GitHub CLI `gh` (a recent release; distro packages can be years old)
- Rust stable via rustup, with `rustfmt` and `clippy`
- Node.js 22 (`desktop/ui-src/.nvmrc`; `engines` in `package.json`)
- The WebKitGTK and build libraries listed in the docs page [Build from source](user/src/contributing/build.md)
- Docker (usable without sudo), `kind`, `kubectl`; `scripts/test-cluster/setup.sh`
  installs `kind` and `kubectl` into `~/.local/bin` when missing
- Optional: `helm` (Helm features and their tests), the Tauri CLI
  (`cargo install tauri-cli --version "^2" --locked`) for `cargo tauri dev/build`
- Recommended on small machines: `sccache`, and a user cargo config that caps
  parallel rustc jobs (see `CLAUDE.md`, "Machine resources"):

  ```toml
  # ~/.cargo/config.toml
  [build]
  jobs = 2
  rustc-wrapper = "/path/to/sccache"
  ```

## 2. Repository and accounts

```sh
gh auth login                       # GitHub (SSH or HTTPS)
git clone git@github.com:nexburst/nauvi.git
cd nauvi
npm --prefix desktop/ui-src ci
cd desktop/ui-src && npx playwright install chromium && cd ../..
```

## 3. Test clusters

```sh
bash scripts/test-cluster/setup.sh            # kind-nauvi-test (+ metrics-server, demo workload)
bash scripts/test-cluster/limited-user.sh     # optional: namespace-scoped user (~/.kube/nauvi-limited.yaml)
```

## 4. Check everything works

Run the checks from `CLAUDE.md` ("Checks"), then one real-app scenario:

```sh
scripts/dev/capped.sh cargo test --workspace
scripts/dev/capped.sh desktop/e2e/qa.sh smoke.test.mjs
```

## 5. Things that are NOT in this repo

Keep these somewhere safe outside git; the repo is public.

| What | Where it lives | If lost |
|---|---|---|
| Tauri updater signing key + password (`cargo tauri signer generate`) | the maintainer's password manager (see below); a copy is in the `release` environment's secrets (usable by CI, not readable) | installed apps can't verify updates signed with a new key: they would need a manual reinstall |
| SSH keys, `gh` login | password manager / regenerate | re-create and re-authorize |
| Claude Code memory notes and machine-specific details (other test machines, addresses) | the maintainer's private backup | agents relearn lessons; `CLAUDE.md` and `docs/decisions/` hold the important ones |
| Conversation transcripts | local only | not needed: issues and PRs are the record |

## 6. Signing secrets

The maintainer keeps the Tauri updater signing key (the encrypted minisign
private key file) and its password in a password manager, outside git. The
public key is `plugins.updater.pubkey` in `desktop/tauri.conf.json`. The key
was last rotated on 2026-11-23, before the first release.

Upload them to CI from the maintainer's own terminal (not one an agent can
read); `gh secret set` reads the value from the file or asks for it, so it is
never printed:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo nexburst/nauvi < ~/nauvi-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo nexburst/nauvi
```

Until `release.yml` reads them from the `release` environment, set the same
two as repository secrets too (drop `--env release`).

To rotate the key: `cargo tauri signer generate -w ~/nauvi-updater.key`
(outside the repository, so it can never be committed), back up the key and
password, upload both, put the new `.pub` contents in
`tauri.conf.json`, run a release dry run (`verify_sigs.py` checks every update
artifact against that key), then delete the key file. After v0.1.0 a new key
means installed copies can no longer verify updates: they need a manual
reinstall, so don't rotate it lightly.

Never paste the private key or its password into a terminal or chat that an
agent can read.

## 7. Other test machines

A Windows machine reachable over SSH works as the Windows test PC (build,
unit tests, WebDriver runs against WebView2): install Git, the Visual Studio
Build Tools C++ workload, Rust (MSVC), Node 22, `kubectl`, `helm`,
`tauri-driver` and the `msedgedriver` matching the installed WebView2 Runtime.
`winget` doesn't work over SSH; use the official installers. GUI runs need the
logged-in desktop session. Its address and account are private notes.
