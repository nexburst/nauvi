# 0003: Release gate for v0.1.0

**Status:** accepted (2026-11-14). Tracker: #84.

## Decision
No first release (no `v*` tag) until **both**:

1. nauvi covers at least 90% of a 30-item scorecard of Lens's most-used
   features (reached 30/30 on 2026-11-15), and
2. QA agents have run every manual check against the real app (#83) and the
   `release-gate` bugs they found are fixed; checks agents cannot do (macOS,
   real managed clusters) are done by the maintainer.

Merging to `main` continues normally; only tagging/publishing is gated.

## Consequences
- The release workflow can already build, sign updater artifacts and publish
  (#29, #30); it stays unused until #84 is complete.
- The updater signing key is generated once and must be backed up outside git
  (see `docs/dev-setup.md`).
