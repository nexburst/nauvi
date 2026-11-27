# See which images have known vulnerabilities

This page shows which images running in your cluster have known
vulnerabilities, which package updates fix them, and which workload
settings to change.

nauvi gets the scans from one of these places:

- the [Trivy Operator](https://aquasecurity.github.io/trivy-operator/), if
  it runs in the cluster: nauvi reads the VulnerabilityReports it keeps
  there, with your own access;
- [Kubescape](https://kubescape.io/), if the cluster has no Trivy Operator
  but runs Kubescape with vulnerability scanning;
- a Trivy or Grype you installed on this computer, if you turn that on
  ([Scan with your own Trivy or Grype](#scan-with-your-own-trivy-or-grype)).

nauvi never downloads a scanner or a vulnerability database. The only thing
nauvi itself downloads for image security is CISA's list of known exploited
vulnerabilities, and only if you turn that on
([Known exploited vulnerabilities](#known-exploited-vulnerabilities)). A
scanner you installed pulls the image, and downloads and updates its own
database unless you turn on **Do not let the scanner update its database**
([Scan with your own Trivy or Grype](#scan-with-your-own-trivy-or-grype)).

## In the app

Image security is off until you turn it on.

1. Open **Settings → Image security** and turn on **Show image
   vulnerabilities from the Trivy Operator**. To turn it on for one cluster
   only, open that cluster's Settings and set **Image security** to **On**
   (or **Off**, to leave one cluster out).
2. Open **Image security** under **Workloads** in the sidebar, or "Go to
   Image security" in the palette (`Ctrl+K`).

The view has two tabs: **Vulnerabilities** (the images) and
**Configuration** (the workloads' settings, see
[The Configuration tab](#the-configuration-tab)).

The **Vulnerabilities** tab has one row per image, the same image in many
pods counted once:

- a verdict in words: "1 critical and 3 high. 3 of 4 have a fix.", or "No
  known vulnerabilities.". A known exploited vulnerability comes first ("1
  known to be exploited in the wild. …"), and ignored ones come last ("…
  2 ignored.");
- the workloads that run it;
- where the scan comes from and how old it is ("Trivy 0.69.3 through Trivy
  Operator, 1 day ago", "Kubescape scan, 2 hours ago" or "Trivy 0.58.1 on
  this computer, 5 minutes ago"). A report more than 7 days old is marked
  **old scan**: the operator may have stopped scanning that image.

The headline counts the images that have a fix waiting ("2 images have fixes
waiting"). Red means a critical vulnerability with a fix, or a vulnerability
known to be exploited in the wild; amber means a critical or high one is
counted, with or without a fix.
The view follows the namespace picker and the filter.

Click a row for its panel:

- **Known to be exploited in the wild**: in red, the vulnerabilities on
  CISA's list, or that Grype marks as exploited
  ([Known exploited vulnerabilities](#known-exploited-vulnerabilities));
- **Most likely to be exploited (EPSS, from the scanner)**: only when the
  scanner gives an EPSS score, which Grype does;
- **What to do**: the fixes by package ("Updating openssl to 3.0.15-1 fixes
  2 (1 critical).");
- **No fix yet**: folded, since there is nothing to do about them now;
- **Ignored (2): not counted**: folded, with each reason
  ([Ignore a vulnerability](#ignore-a-vulnerability));
- **Ignore a vulnerability…**;
- the scanner, the image digest, the workloads and the report. Vulnerability
  IDs open in your browser.

### Where else findings show

While image security is on, the same findings show where you already look:

- a **Vulns** column for Pods, Deployments, StatefulSets, DaemonSets, Jobs
  and CronJobs, off by default: turn it on in **Columns**.
  `2C 5H` means 2 critical and 5 high, at the severity you chose; `KEV 2H`
  means one of them is known to be exploited. Hover it for each image;
- a **Security** tab in the detail panel of a Deployment, StatefulSet,
  DaemonSet, ReplicaSet, Job or CronJob, with each image's verdict
  and **Show fixes**;
- a **Vulns** line on each container card in the pod panel, with
  **Details**;
- an **Image fixes** card on the Overview: how many images have a fix
  waiting. A click opens the Image security view;
- **Copy as prompt** (`A`) on a workload adds its worst images and their
  counts.

A vulnerability is not an outage: it never counts as a problem pod or a
problem workload.

### Settings

**Settings → Image security** also has:

- **Source**: where the scans come from
  ([Scan with your own Trivy or Grype](#scan-with-your-own-trivy-or-grype));
- **Count**: the least severity to count (**High and critical** by default);
- **Only vulnerabilities that have a fix**;
- **Leave out namespaces**, for example `kube-system, monitoring`;
- **Read the reports again after**: how long a reading is reused (1 day by
  default, from 1 hour to 7 days);
- **Ignores**: an **Ignore file** and your own ignores
  ([Ignore a vulnerability](#ignore-a-vulnerability));
- **Download CISA's list of known exploited vulnerabilities**, off by
  default ([Known exploited vulnerabilities](#known-exploited-vulnerabilities)).

Changing what to count or leave out reads nothing again. Adding or removing
an ignore reads the reports again.

### When nothing is listed

Each case has its own message:

| Message | What to do |
| --- | --- |
| Image security is off for this cluster | Click **Turn on for this cluster**, or turn it on in Settings |
| This cluster has no Trivy Operator reports | The cluster serves neither the Trivy Operator's VulnerabilityReports nor Kubescape's summaries: install one of them there, or [scan with your own Trivy or Grype](#scan-with-your-own-trivy-or-grype) |
| Not scanned yet | The operator (or Kubescape) has no reports here yet. It scans new workloads within minutes; check that it watches these namespaces |
| You are not allowed to list vulnerabilityreports in namespace X | Ask for `list` on `vulnerabilityreports.aquasecurity.github.io` (for Kubescape, `vulnerabilitymanifestsummaries.spdx.softwarecomposition.kubescape.io`), or pick a namespace you may read |

Images no report covers yet are listed as not scanned.

## The Configuration tab

The **Configuration** tab lists each workload with the checks it fails,
worst first. The checks come from the Trivy Operator's ConfigAuditReports:
it checks each workload's settings, such as limits, probes and security
context. A row says "Fails 3 checks: 1 critical and 2 high." or "Passes every
check.", and the headline counts the workloads with settings to change.

Click a workload to see **What to change**: each failed check's title, how to
fix it, the container it is about, and the operator's message.
Lower-severity checks are folded. A Deployment is shown by its own name, not
its ReplicaSet's, and a CronJob by its name, not its Job's.

The **Count** and **Leave out namespaces** settings apply to the checks too.
The tab reads the reports only while it is open, like the vulnerabilities.

The checks come from the cluster only. With **Source** set to **A scanner on
this computer**, nauvi reads nothing from the cluster, and the tab says
"Configuration checks come from the cluster" with a **Settings…** button. To
see the checks, set **Source** to **Trivy Operator reports in the cluster**
or **Cluster reports, then this computer for the rest**.

When nothing is listed:

| Message | What to do |
| --- | --- |
| This cluster has no configuration audits | The cluster does not serve ConfigAuditReports: install the Trivy Operator there |
| Not checked yet | The operator has no ConfigAuditReports here yet. It checks new workloads within minutes; check that it watches these namespaces |
| You are not allowed to list configauditreports in namespace X | Ask for `list` on `configauditreports.aquasecurity.github.io`, or pick a namespace you may read |

## Kubescape

If the cluster has no Trivy Operator but runs Kubescape with vulnerability
scanning, nauvi reads Kubescape's VulnerabilityManifestSummaries instead.
When a cluster has both, nauvi shows the Trivy Operator's reports.

A Kubescape summary counts vulnerabilities by severity only. So a row says
how many there are ("1 critical and 2 high. Open it to see which have a
fix."). Click it to see which have a fix: nauvi then reads the full
VulnerabilityManifest of that image. Kubescape's "Negligible" counts as low.

Ignores and known exploited vulnerabilities apply to a Kubescape image once
you open it, since its summary names no vulnerabilities.

You need `list` on `vulnerabilitymanifestsummaries` and `get` on
`vulnerabilitymanifests` (group `spdx.softwarecomposition.kubescape.io`).

## Scan with your own Trivy or Grype

If your cluster has no Trivy Operator, nauvi can use a
[Trivy](https://trivy.dev/) or [Grype](https://github.com/anchore/grype)
you installed on this computer. nauvi never downloads the scanner. The
scanner downloads and updates its own vulnerability database when it scans,
unless you turn on **Do not let the scanner update its database**.

1. Install Trivy or Grype yourself. nauvi looks for `trivy` or `grype` on
   your `PATH`. Set `NAUVI_TRIVY` or `NAUVI_GRYPE` to the full path of a
   file to use another one.
2. In **Settings → Image security**, set **Source** to **A scanner on this
   computer**, or to **Cluster reports, then this computer for the rest**.
   Then pick the **Scanner**.
3. nauvi shows the file it found, its size and its SHA-256. Hover the size
   and SHA-256 for the full SHA-256, or click **Copy SHA-256** to compare it with the
   one your package manager or the release page lists.
4. Click **Approve** (followed by the file's path) to let nauvi run that file. nauvi runs nothing of it
   before you approve it, not even to read its version. If the file changes
   (an update, or another file first on your `PATH`), nauvi asks again.
5. In the **Image security** view, click **Scan N images with Trivy** (or
   Grype) above the list, or open an image and click **Scan with Trivy**.
   One image is scanned at a time; **Cancel** stops it. A scan of all
   images goes on when you switch to the **Configuration** tab and back.

The three **Source** choices:

| Source | What the view lists |
| --- | --- |
| Trivy Operator reports in the cluster | The reports in the cluster (the default) |
| A scanner on this computer | The images of the pods, scanned only on this computer |
| Cluster reports, then this computer for the rest | The reports in the cluster; an image no report covers can be scanned on this computer. With no reports to read, the pods' images |

An image not scanned yet says "Not scanned on this computer yet". nauvi
never scans on its own: a scan starts only when you click.

How a scan works:

- The scanner runs on this computer. It pulls each image by its digest from
  the registry (Trivy reads the registry directly, not a local Docker), with
  your own `docker login`. nauvi does not use the cluster's pull secrets. If
  the registry cannot be reached from this computer, the scan says so.
- An image whose pods do not report a digest yet cannot be scanned.
- nauvi refuses registries written as this computer (`localhost`,
  `127.0.0.1`), link-local addresses and cloud metadata names. The scanner
  looks up names itself, so this does not block every local address.
- nauvi turns off Trivy's telemetry and version check, and Grype's update
  check.
- Results are kept on this computer and reused until the scanner's version,
  its database or the platform changes. If nauvi cannot tell when Grype's
  database was built, a kept result is reused after a database update too:
  click **Scan again**.

Options in **Settings → Image security**:

- **Database repository** (Trivy): a mirror of the Trivy database;
- **Trivy server** (Trivy): scan through a Trivy server;
- **Do not let the scanner update its database**;
- **Forget approval** and **Check again**.

### Which Trivy nauvi runs

Trivy 0.69.4 to 0.69.6 were malicious releases (CVE-2026-33634): they ran
malicious code as soon as they started, even to print their version. So
nauvi reads a Trivy's version from its file before it ever runs it, and
runs it only when it can tell the version that way:

- Trivy's release builds record their version in the file. These are the
  builds from its GitHub releases, its apt or yum repository and the
  `aquasecurity/trivy` Homebrew tap.
- A Trivy installed with Homebrew (in a `Cellar/trivy/<version>` folder) or
  Nix (in `/nix/store/…-trivy-<version>`) does not record its version in the
  file. nauvi reads the version from the folder it was installed in, and
  Settings says so: "Version 0.58.1 from its Homebrew folder."
- Any other Trivy that does not record its version is refused before it
  runs, approved or not: one built from source (without
  `-X github.com/aquasecurity/trivy/pkg/version/app.ver=<version>`, or with
  `-trimpath`), a packed binary, a script around Trivy, or a distribution's
  own build such as Arch's.

Trivy 0.69.4 to 0.69.6 are refused either way, wherever the version comes
from. A refused Trivy shows the reason in red in Settings, with no
**Approve** button. To use Trivy, install a release build (from its GitHub
releases, its apt or yum repository or the `aquasecurity/trivy` tap),
install it with Homebrew or Nix, or set `NAUVI_TRIVY` to the full path of
a release build. Then click **Check again**. Grype is not affected.

## Ignore a vulnerability

Some findings do not matter to you: the vulnerable code is never reached, or
you accept the risk until the next rebuild. You can ignore them.

1. Open the image's panel and click **Ignore a vulnerability…**.
2. Pick the **Vulnerability**.
3. Pick where to ignore it (**In**): every image of that repository, any
   tag, in every cluster; that one workload; or that namespace. The last two apply to the
   current cluster only, and are offered when the image runs in only one
   workload or one namespace.
4. Pick how long (**Until**): 30 days, 90 days, 1 year or never.
5. Say why (**Reason**). A reason is required.

An ignored vulnerability is not counted, but it is never hidden. The row
says "2 ignored", and the panel lists them under **Ignored**, with their
reasons and end dates, and **Stop ignoring**. When an ignore ends, the
vulnerability counts again. **Settings → Image security** lists your
ignores, with **Remove**; an ended one is shown greyed out, "expired on …".

If you already keep a `.trivyignore`, set its full path as the **Ignore
file** in **Settings → Image security**. Its vulnerabilities are ignored in
every image. `exp:2026-12-31` after an ID ends it on that day. A `# comment`
on the line, or just above it, is its reason; without one the reason is
"Listed in .trivyignore". Settings says how many ignores it read, and the
numbers of the lines it did not understand.

## Known exploited vulnerabilities

nauvi can mark the vulnerabilities that CISA lists as known to be exploited
in the wild (the KEV catalogue). This is off unless you turn on **Download
CISA's list of known exploited vulnerabilities** in **Settings → Image
security**.

- nauvi then downloads one file from `www.cisa.gov` over https, and again
  once a day while image security is shown. **Download now** downloads it at
  once.
- Nothing about your clusters or images is sent: it is a plain download of
  one public file.
- Settings shows the catalogue's version, how many vulnerabilities it lists
  and when it was downloaded. Turning the setting off deletes the kept copy.

A finding on the list comes first in the verdict ("1 known to be exploited
in the wild"), the image is shown in red whatever its severity, and the
Vulns column says `KEV`. Grype marks known exploited vulnerabilities itself,
without the download.

Where the scanner gives them (Grype), the panel also shows each
vulnerability's EPSS score: how likely it is to be exploited in the next 30
days. nauvi downloads nothing for EPSS.

## What nauvi reads, and when

- Nothing while image security is off, at start-up or later.
- While it is on for a cluster, nauvi lists the reports when the Image
  security view, the Overview, a pod or workload panel or the Vulns column
  is shown. It keeps only the counts of each report; it reads one full
  report when you open an image's panel.
- One reading is shared by all of these and reused for the time set in
  **Read the reports again after**. **Read again** in the view reads them
  now. There is no watch and no polling.
- With a scanner on this computer, nauvi lists the pods to see which images
  run. It scans only when you click. With **Source** set to **A scanner on
  this computer**, it reads no reports from the cluster, not even for the
  **Configuration** tab.

## From the CLI

`nauvi vulns` lists the same images, one row per image, with its counts by
severity, how many have a fix, when it was scanned and the workloads that
use it. The **SCANNED** column shows how old the data is. It reads the
Trivy Operator's reports, or Kubescape's when there is no Trivy Operator.

```sh
nauvi vulns                          # every namespace you may read
nauvi vulns -n shop                  # one namespace
nauvi vulns --severity high --fixable  # what to upgrade first
nauvi vulns nginx:1.27               # one image: its fixes by package
```

Without either of them, or without permission to list their reports,
`nauvi vulns` says so and exits with 1. With no reports yet it says how many
running images are not scanned. See
[`nauvi vulns`](../reference/cli/inspect.md#nauvi-vulns) for every option.

`nauvi vulns` never runs a scanner, and it does not apply your ignores or
the known exploited list.

## From an AI assistant

`nauvi mcp` has a read-only `image_vulnerabilities` tool with the same data
as `nauvi vulns` ([MCP tools](../reference/mcp-tools.md)). Like the CLI, it
does not see local scans and does not apply ignores or the known exploited
list.
