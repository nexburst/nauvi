# 0008: The project is called nauvi

**Status:** accepted (2026-11-16). Issue #337.

## Context
The project started under a working name that was already taken. It was
renamed before the first release and before the repository moved to the
`nexburst` organization, so no release ever shipped under the old name.

## Decision
Everything is called nauvi: the crates (`nauvi`, `nauvi-desktop`), the binary
and the MCP server (`nauvi`, `nauvi mcp`), the app (productName `nauvi`,
identifier `com.nauvi.app`, deep links `nauvi://`), the environment variables
(`NAUVI_*`), the test clusters (`kind-nauvi-test`, `kind-nauvi-staging`), the
release assets and the repository (`nexburst/nauvi`). The old name is not
mentioned anywhere: not in the README, the docs, the site or release notes.

## Consequences
- No settings migration: nothing was released under the old name.
- A development machine set up before the rename has the old kind clusters;
  re-run `bash scripts/test-cluster/setup.sh` (and `limited-user.sh`) to get
  the new ones, and delete the old clusters with `kind delete cluster`.
- CI fails if the old name appears in any tracked file or path
  (`scripts/dev/check-old-name.sh`), with no exceptions.
