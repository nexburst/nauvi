# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it
privately through GitHub's security advisories:
<https://github.com/nexburst/nauvi/security/advisories/new>
(the repository's **Security** tab, then **Report a vulnerability**).

Include the nauvi version, your OS, what you did, what happened and,
if you can, a way to reproduce it. You should get a first answer within a
week. Please give us a reasonable time to release a fix before you disclose
the problem publicly.

## Supported versions

Fixes go into the latest release only. nauvi is pre-1.0, so please
check that the problem still happens on the latest release.

## Scope

In scope:

- The nauvi desktop app and the `nauvi` CLI in this repository.
- How they handle kubeconfig files, credentials, tokens and exec
  credential plugins (for example leaking them into logs, files or
  other processes).
- The IPC between the app's UI and its backend, and anything a malicious
  cluster object (names, labels, log lines, YAML) can make the UI run or
  open.
- Port forwarding, exec and shell sessions reaching more than the user
  asked for.
- The release artifacts and the updater (signature checks, download URLs).

Out of scope:

- Vulnerabilities in Kubernetes itself, in your cluster or in tools
  nauvi calls (kubectl credential plugins, helm, cloud CLIs); report
  them to those projects.
- Actions a user is already allowed to do with their own credentials
  (nauvi acts with the permissions of your kubeconfig).
- Attacks that need control of your machine or your user account.
