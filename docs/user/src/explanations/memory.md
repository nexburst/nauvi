# Size and memory

nauvi is built to stay small while it runs for days. This page gives the
measured numbers and the budgets CI holds it to.

## Download sizes

Of the v0.1.0 dry run:

| Platform | Download | Size |
| --- | --- | ---: |
| Linux | AppImage | 88.7 MB |
| Linux | .deb | 15.6 MB |
| macOS (universal) | .dmg | 26.8 MB |
| Windows | NSIS installer (`-setup.exe`) | 8.8 MB |
| Windows | .msi | 13.2 MB |
| CLI | .tar.gz / .zip | 7.6–9.1 MB |

The AppImage is larger because it carries its own WebKitGTK; the `.deb` uses
the system's.

## Idle memory

On Linux (release build, 30 s idle on the Overview of a kind cluster, no
GPU):

| Measure | Memory |
| --- | ---: |
| App process (RSS) | 136 MB |
| App + WebKitWebProcess (RSS) | 335 MB |
| All processes (PSS) | 234 MB |

PSS splits the shared libraries between the processes, so it is the fairer
total. The numbers come from one CI run; macOS and Windows are not measured
yet. CI keeps them in check: the `idle-memory` QA scenario fails a release
build above 159 MB, 389 MB and 274 MB (the numbers above plus 15%).

On a machine without a GPU (VMs, remote desktops), nauvi turns WebKitGTK's
DMA-BUF renderer off by itself, which saves about 170 MB.

## Memory while you work

Memory also stays flat while you use the app:

- A table keeps only its rows, not a copy of every full object.
- Memory freed when you leave a table goes back to the system (on Linux).
- A pod's log stream is bounded, so a flood waits in the API server instead
  of piling up in the app.

Growth over the idle baseline on Linux (release build, private dirty memory,
median of 5 reads, a Config Maps table of 5,016 rows):

| Step | App process | WebKitWebProcess |
| --- | ---: | ---: |
| Config Maps table open | +10 MB (was +84) | +16 MB (was +22) |
| Back on the Overview | +8 MB (was +87) | +14 MB (was +23) |
| The table again | +14 MB (was +139) | +18 MB (was +30) |
| Back on the Overview again | +11 MB (was +140) | +13 MB (was +30) |
| A 50,000-line log tab open | +2.5 MB | +39 MB |
| That tab closed | +0.5 MB | −11.5 MB |

The app process was 276 MB RSS after two visits to that table, and is now
153 MB. The `growth-memory` QA scenario fails a release build whose growth
goes over its budgets (app process 25–30 MB per step).

## Budgets

These are checked in CI; a change that goes over one fails.

| Budget | Limit | Where |
| --- | --- | --- |
| Backend memory per idle connected cluster | at most 5 MB RSS | every PR (cluster tests) |
| Whole app per idle connected cluster | at most 15 MB PSS (core + WebKitWebProcess) | nightly QA, release build |
| Start-up with 50 contexts in 3 files, 49 unreachable | cluster tree within 1.5 s, at most 200 ms later than with 1 context | nightly QA |
| Idle memory on the Overview | the numbers above plus 15% | nightly QA, release build |
| Growth while you use the app | 25–30 MB per step (app process) | nightly QA, release build |

Work on memory is tracked in
[#353](https://github.com/nexburst/nauvi/issues/353).
