# Build from source

## What you need

- Rust 1.95 or newer.
- A kubeconfig (`~/.kube/config`, or `KUBECONFIG`) pointing at a cluster, or
  in-cluster config when running inside Kubernetes.
- For the desktop app: Node (the version in `desktop/ui-src/.nvmrc`), the
  Tauri CLI, and on Linux the WebKitGTK libraries:

  ```sh
  sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  macOS and Windows need nothing extra.

## The CLI

```sh
cargo run -- --help
cargo run -- get deploy -n kube-system
cargo run -- logs deploy/<name> -n <namespace> -f
```

## The desktop app

```sh
cargo install tauri-cli --version "^2" --locked   # once
npm --prefix desktop/ui-src ci                    # once, and after lockfile changes
cd desktop && cargo tauri dev                     # starts Vite on :1420 and the app
```

A debug build loads the UI from the Vite dev server, so
`cargo run -p nauvi-desktop` on its own shows a connection error unless
`npm --prefix desktop/ui-src run dev` is running.

`cd desktop && cargo tauri build` builds the UI (`npm run build` in
`desktop/ui-src`) and makes a release build with it bundled; add
`--no-bundle` to skip the installers. The installers include signed update
bundles, which need the release signing key (`TAURI_SIGNING_PRIVATE_KEY`);
without it, build them unsigned with:

```sh
cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## Trying the update banner

Debug builds never check for updates. To try the update banner, serve a
`latest.json` with a higher `version` (for example with
`python3 -m http.server` in its folder) and start the app with
`NAUVI_UPDATE_ENDPOINT=http://127.0.0.1:8000/latest.json cargo tauri dev`.
Release builds ignore this variable. Installing from it also needs bundles
signed with the release key.
