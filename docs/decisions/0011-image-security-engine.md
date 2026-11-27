# 0011: Image security reads the cluster's own scan reports; a local scanner is the user's, never downloaded

**Status:** accepted (2026-11-26). Issue #533; the plan continues in #534–#538.

## Context
People want to know which running images have known vulnerabilities. A
scanner needs a vulnerability database, registry access and credentials,
and it parses untrusted images. In March 2026 a malicious Trivy release
(v0.69.4, CVE-2026-33634) was published with stolen credentials: a tool
that downloads and runs a scanner inherits that supply chain.

## Decision
- **Off by default**, per app and per context.
- **Source 1: the Trivy Operator's `VulnerabilityReport`s**
  (`aquasecurity.github.io/v1alpha1`, one per workload container), read
  with the user's own RBAC. No watch, no polling, nothing at start-up:
  reports are read when the user asks. Whether the CRD exists comes from
  discovery; who may list the reports from `can_list`, namespace by
  namespace when the cluster-wide list is forbidden.
- **Source 2 (a separate opt-in, #536): a Trivy or Grype the user
  installed** (`PATH`, `NAUVI_TRIVY`/`NAUVI_GRYPE`), run on an approved
  path. nauvi never downloads a scanner or a vulnerability database. Image
  references are validated and never pass through a shell; known
  compromised versions are refused.
- **nauvi does not read `imagePullSecrets`**; a local scanner uses the
  user's own docker config.
- **Results are grouped by image digest** (from the pods'
  `containerStatuses[].imageID`, by reference when there is none): the same
  image in N pods is one row. They are never "problems": no pill, no
  notification.
- **Logic in `src/image_security/`**, used by the CLI (`nauvi vulns`) and
  the MCP tool (reports only). A listing reads the reports in small pages
  and keeps only their counts; one full report is read only when it is
  shown.

## Rejected
- A built-in Rust scanner: accuracy, binary size, and a database to run.
- Registry scan APIs (ECR, GCR/Artifact Registry, ACR, Harbor): four
  credential models.
- Downloading Trivy on demand: the supply chain above.

## Consequences
- Without the operator and without a local scanner there is nothing to
  show, and nauvi says so plainly (no operator, no reports yet, not
  allowed: three different messages).
- The data is as old as the operator's last scan; its age is always shown.
- The kind test cluster has only the VulnerabilityReport CRD
  (`scripts/test-cluster/trivy-vulnerabilityreports-crd.yaml`, vendored);
  tests create fixture reports, no operator runs.

## Amendment (2026-11-26, #535)
"Nothing at start-up: reports are read when the user asks" now covers more
places than the Image security view. While image security is on for a
context, the reports are also read when the Overview (its image findings
card), a pod or workload panel (the container cards, the Security tab) or
the Vulns column is shown. It is still one cached listing per context
(`cache_ttl_hours`), shared by the view and all of these, with no watch
and no polling. While the feature is off nothing is read, at start-up or
later.
