# Use a proxy

This page sets up nauvi to reach a cluster through an HTTP, HTTPS or SOCKS5
proxy.

## nauvi ignores the environment's proxy

The app and the CLI ignore `HTTPS_PROXY` (and `NO_PROXY`) from the
environment when they talk to a cluster, so a machine-wide proxy doesn't
break access to local or internal clusters. To reach a cluster through a
proxy, use one of the two ways below.

## In the kubeconfig

Set `proxy-url` on the cluster's entry, as for `kubectl`:

```yaml
clusters:
  - name: prod
    cluster:
      server: https://prod.example.com
      proxy-url: http://proxy.example.com:3128
```

An `https://` `proxy-url` in a kubeconfig is checked against the system's
trust store only.

## In the app, per cluster

Open the cluster's **Settings → Network** and set a proxy URL:
`http://`, `https://` or `socks5://`. It is used for that cluster's
requests, watches, terminals and port forwards, and replaces the
kubeconfig's `proxy-url` for that cluster.

- A proxy that wants a login: `http://user:password@host:port`. SOCKS5 works
  without one. The password is shown masked.
- An `https://` proxy's certificate is checked against the system's trust
  store, plus an optional CA file (a PEM file, full path) set under the proxy
  URL. The cluster's certificate authority, `insecure-skip-tls-verify` and
  client certificate are never used for the proxy.
- A cluster on your machine (kind, minikube) is reached directly unless you
  tick **Also for a cluster on this machine**.
- It applies the next time a window connects: click **Reconnect now**.

nauvi keeps the proxy in `proxies.json` in its config folder (readable only
by you), never in your kubeconfig.

## What does not use it

- `helm` and `kubectl` started from the app (Helm actions, the local
  terminal) use the environment as usual, not these proxies.
- The matching-kubectl download (see [The dock and terminals](../reference/app/dock.md#matching-kubectl))
  uses the cluster's proxy but not its CA file; add that CA to the system
  trust store instead.

The app window itself loads nothing from the network: a strict Content
Security Policy allows only the app's own files and its IPC.
