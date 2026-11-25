# Links to objects

**Copy link**, in the detail panel's header and the row menu, copies a
`nauvi://` link to the object, such as:

```text
nauvi://my-context/apps/v1/Deployment/shop/web
```

The parts are the context, the API group (`core` for the core group), the
version, the kind, the namespace (`_` for none) and the name.

Opening a link (from a browser, a chat, or `xdg-open`, `open`, `start`)
brings nauvi to the front and shows that object in a window on that context,
opening one if needed.

- A link **only opens a view**; it never changes the cluster.
- Opening a context from your default kubeconfig may run its login command,
  as switching to it does.
- A link to a context that is not in your kubeconfigs only shows a notice.

## Which installs handle links

The Linux `.deb` and the install script's menu entry, the macOS app and the
Windows installers register the `nauvi://` scheme. A plain AppImage doesn't:
it handles links only if you set up desktop integration (for example with
AppImageLauncher). A build from source doesn't either.
