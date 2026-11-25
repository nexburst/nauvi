# Contributing

nauvi is developed in the open at
[github.com/nexburst/nauvi](https://github.com/nexburst/nauvi). Bugs and
ideas go to the [issues](https://github.com/nexburst/nauvi/issues); the plan
is the [roadmap (#24)](https://github.com/nexburst/nauvi/issues/24).

- [CLAUDE.md](https://github.com/nexburst/nauvi/blob/main/CLAUDE.md) (also
  `AGENTS.md`) is the contributor guide: the code layout, the checks CI runs,
  how to regenerate the IPC bindings, and how to run the unit, frontend and
  cluster tests.
- [docs/dev-setup.md](https://github.com/nexburst/nauvi/blob/main/docs/dev-setup.md)
  sets up a development machine.
- [docs/ux-standard.md](https://github.com/nexburst/nauvi/blob/main/docs/ux-standard.md)
  is the UX standard the app is measured against: what Lens, k9s, Headlamp,
  Aptakube and others share, where nauvi stands on each point, and the
  backlog that follows from it.
- [docs/decisions/](https://github.com/nexburst/nauvi/tree/main/docs/decisions)
  explains why things are the way they are.

## These docs

These pages are Markdown in
[`docs/user/`](https://github.com/nexburst/nauvi/tree/main/docs/user),
built with mdBook. The CLI reference is generated from the CLI's definitions
(`src/args.rs`). Build the site, landing page included, with:

```sh
python3 scripts/site/build.py --check
python3 -m http.server -d target/site 8000
```

- [Build from source](build.md)
- [The test cluster](test-cluster.md)
