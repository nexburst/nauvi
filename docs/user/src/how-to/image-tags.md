# Find a newer tag for an image

This page shows which newer tags the registry has for an image you run, and
whether the tag you run was pushed again since your pod pulled it.

## In the app

**Available tags** is off until you turn it on.

1. Open **Settings → Clusters → Container images** and turn on **Show
   available tags**.
2. Open a pod's detail panel. Each container card now has an **Available
   tags** button under its image. The panel of a Deployment, StatefulSet,
   DaemonSet, ReplicaSet, Job or CronJob has the same button in its **Images**
   section, one per container of the pod template.
3. Click it. nauvi asks the image's registry for its tags and lists the
   newer ones, newest first:
   - **Newer patch**: safe to update;
   - **Newer minor**: new features;
   - **Newer major**: may break things;
   - **Not versions**: tags like `latest` or `stable`, listed apart.

The tag's variant and prefix are kept: `7.0.1-jammy` is offered
`7.0.2-jammy`, never `7.0.2-alpine`, and `v1.2.3` only `v…` tags. A floating
tag such as `1.36` is compared with `1.37`, not with `1.36.1`. Docker Hub
also gives the date each tag was pushed.

In the pod panel, nauvi also compares the tag in the registry with what the
container runs. It says "This tag was updated in the registry" when the tag
now points to another image, "still points to what the container runs", or
that the registry no longer has the tag. When the pod does not report a
registry digest (for example an image loaded straight into the node), it
says nothing about it.

nauvi only shows tags. To update an image, edit the workload's YAML
([Edit a Deployment's YAML safely](edit-yaml.md)).

## From the CLI

`nauvi tags` does the same without a cluster connection:

```sh
nauvi tags mongo:7.0.1
nauvi tags ghcr.io/stefanprodan/podinfo:6.5.0 --json
```

Give `--image-id` the `imageID` a pod reports
(`docker.io/library/mongo@sha256:…`) to learn whether the tag was pushed
again. See [`nauvi tags`](../reference/cli/inspect.md#nauvi-tags).

## Which registries work

- **Public images** on Docker Hub, GitHub (ghcr.io) and Quay work without a
  login.
- **Private images** use your own `docker login`: the `auths` of
  `~/.docker/config.json` (or `$DOCKER_CONFIG/config.json`) and its
  credential helpers. nauvi never uses the cluster's image pull secrets.
- Registries that work: Docker Hub, GHCR, Quay, Harbor, GitLab (gitlab.com
  and self-hosted), Azure Container Registry, and others that sign you in on
  their own host or its parent domain.
- Registries that do not work yet:
  - those that sign in on an unrelated host (for example nvcr.io, which
    signs in at authn.nvidia.com);
  - Amazon ECR and Google Artifact Registry, which need cloud credentials;
  - a private project on a self-hosted GitLab whose registry has its own
    port (public projects work);
  - a registry you can reach only through a proxy.

## What it asks, and from where

- Only when you click. Nothing is asked at start-up or while you are idle.
  An answer is reused for 10 minutes; **Refresh** asks again.
- From your computer, over HTTPS only. The cluster's proxy setting is not
  used, and neither are proxy environment variables.
- Registries on your private network (an internal Harbor, for example) work.
  Loopback, link-local and cloud metadata addresses are refused, even when a
  registry's name points to one.
