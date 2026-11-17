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
- The WebKitGTK and build libraries listed in [README.md](../README.md#build-and-run-from-source)
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
| Tauri updater signing key + password (`cargo tauri signer generate`) | 1Password, vault `dev` (see below); a copy is in the repo's Actions secrets (usable by CI, not readable) | installed apps can't verify updates signed with a new key: they would need a manual reinstall |
| SSH keys, `gh` login | password manager / regenerate | re-create and re-authorize |
| Claude Code memory notes and machine-specific details (other test machines, addresses) | the maintainer's private backup | agents relearn lessons; `CLAUDE.md` and `docs/decisions/` hold the important ones |
| Conversation transcripts | local only | not needed: issues and PRs are the record |

## 6. Secrets with 1Password

The maintainer keeps secrets in 1Password, vault `dev`:

- `nauvi updater key` (document): the minisign private key, encrypted
- `nauvi updater key password` (password, field `password`)

Install the 1Password desktop app and CLI (`op`), sign in in the app, and turn
on **Settings → Developer → Integrate with 1Password CLI**. Then every `op`
command asks the maintainer to approve it in the app: agents can run commands
that *use* a secret, but never see it and never run them unapproved.

Examples:

```sh
# Re-upload the CI signing secrets (e.g. after rotating the key)
op document get "nauvi updater key" --vault dev | gh secret set TAURI_SIGNING_PRIVATE_KEY
op read "op://dev/nauvi updater key password/password" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# Sign a local build with the updater key, without writing it to disk
TAURI_SIGNING_PRIVATE_KEY="$(op document get 'nauvi updater key' --vault dev)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(op read 'op://dev/nauvi updater key password/password')" \
  cargo tauri build
```

Never paste the 1Password Secret Key or account password into a terminal or
chat that an agent can read; only the 1Password app should see them.

## 7. Other test machines

A Windows machine reachable over SSH works as the Windows test PC (build,
unit tests, WebDriver runs against WebView2): install Git, the Visual Studio
Build Tools C++ workload, Rust (MSVC), Node 22, `kubectl`, `helm`,
`tauri-driver` and the `msedgedriver` matching the installed WebView2 Runtime.
`winget` doesn't work over SSH; use the official installers. GUI runs need the
logged-in desktop session. Its address and account are private notes.
