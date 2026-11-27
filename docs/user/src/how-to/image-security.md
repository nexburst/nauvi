# See which images have known vulnerabilities

This page shows which images running in your cluster have known
vulnerabilities, and which package updates fix them.

nauvi scans nothing and downloads nothing itself. It reads the scans the
[Trivy Operator](https://aquasecurity.github.io/trivy-operator/) already
keeps in the cluster (its VulnerabilityReports), with your own access. So
you need the Trivy Operator installed in the cluster, and permission to list
`vulnerabilityreports.aquasecurity.github.io`.

## In the app

Image security is off until you turn it on.

1. Open **Settings → Image security** and turn on **Show image
   vulnerabilities from the Trivy Operator**. To turn it on for one cluster
   only, open that cluster's Settings and set **Image security** to **On**
   (or **Off**, to leave one cluster out).
2. Open **Image security** under **Workloads** in the sidebar, or "Go to
   Image security" in the palette (`Ctrl+K`).

The view has one row per image, the same image in many pods counted once:

- a verdict in words: "1 critical and 3 high. 3 of 4 have a fix.", or "No
  known vulnerabilities.";
- the workloads that run it;
- where the scan comes from and how old it is ("Trivy 0.69.3 through Trivy
  Operator, 1 day ago"). A report more than 7 days old is marked **old
  scan**: the operator may have stopped scanning that image.

The headline counts the images that have a fix waiting ("2 images have fixes
waiting"). Red means a critical vulnerability with a fix, amber a high one.
The view follows the namespace picker and the filter.

Click a row for its panel:

- **What to do**: the fixes by package ("Updating openssl to 3.0.15-1 fixes
  2 (1 critical).");
- **No fix yet**: folded, since there is nothing to do about them now;
- the scanner, the image digest, the workloads and the report. Vulnerability
  IDs open in your browser.

### Where else findings show

While image security is on, the same findings show where you already look:

- a **Vulns** column for Pods, Deployments, StatefulSets, DaemonSets, Jobs
  and CronJobs, off by default: turn it on in **Columns**.
  `2C 5H` means 2 critical and 5 high, at the severity you chose. Hover it
  for each image;
- a **Security** tab in a workload's detail panel, with each image's verdict
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

- **Count**: the least severity to count (**High and critical** by default);
- **Only vulnerabilities that have a fix**;
- **Leave out namespaces**, for example `kube-system, monitoring`;
- **Read the reports again after**: how long a reading is reused (1 day by
  default, from 1 hour to 7 days).

Changing what to count or leave out reads nothing again.

### When nothing is listed

Each case has its own message:

| Message | What to do |
| --- | --- |
| Image security is off for this cluster | Click **Turn on for this cluster**, or turn it on in Settings |
| This cluster has no Trivy Operator reports | The cluster does not serve VulnerabilityReports: install the Trivy Operator there |
| Not scanned yet | The operator has no reports here yet. It scans new workloads within minutes; check that it watches these namespaces |
| You are not allowed to list vulnerabilityreports in namespace X | Ask for `list` on `vulnerabilityreports.aquasecurity.github.io`, or pick a namespace you may read |

Images no report covers yet are listed as not scanned.

## What nauvi reads, and when

- Nothing while image security is off, at start-up or later.
- While it is on for a cluster, nauvi lists the reports when the Image
  security view, the Overview, a pod or workload panel or the Vulns column
  is shown. It keeps only the counts of each report; it reads one full
  report when you open an image's panel.
- One reading is shared by all of these and reused for the time set in
  **Read the reports again after**. **Read again** in the view reads them
  now. There is no watch and no polling.

## From the CLI

`nauvi vulns` lists the same images, one row per image, with its counts by
severity, how many have a fix, when it was scanned and the workloads that
use it. The **SCANNED** column shows how old the data is.

```sh
nauvi vulns                          # every namespace you may read
nauvi vulns -n shop                  # one namespace
nauvi vulns --severity high --fixable  # what to upgrade first
nauvi vulns nginx:1.27               # one image: its fixes by package
```

Without the Trivy Operator, or without permission to list its reports,
`nauvi vulns` says so and exits with 1. With no reports yet it says how many
running images are not scanned. See
[`nauvi vulns`](../reference/cli/inspect.md#nauvi-vulns) for every option.

## From an AI assistant

`nauvi mcp` has a read-only `image_vulnerabilities` tool with the same data
([MCP tools](../reference/mcp-tools.md)).
