# Edit a Deployment's YAML safely

This page changes a Deployment (or any other object) by editing its YAML in
the app, without overwriting what others changed.

1. Open the Deployment: **Workloads → Deployments**, then click its row.
2. Press `E` (or `Y`), or click **Edit** in the panel's header. The YAML
   editor opens and takes the whole window.
3. Make your change, for example the image or the replica count.
4. Click **Save**.

nauvi saves with **server-side apply**. The API server merges your fields
with everyone else's, so a field you did not touch keeps its current value.
After saving, nauvi tells you which fields it took over from other field
managers, for example from `kubectl` or a controller. A controller that
manages a field you took over (a HorizontalPodAutoscaler and `replicas`, say)
may set it back, so check that list.

Good to know:

- Secret values stay hidden in the editor until you reveal them.
- Closing the window or quitting with unsaved edits asks first: **Keep
  editing** or **Discard changes**.
- On a [protected cluster](../reference/app/modes.md), saving asks you to
  type the context's name; on a read-only one it is refused.
- For a small change, an action may be quicker: **Scale** and **Restart**
  are in the row menu and the panel ([Actions](../reference/app/actions.md)).
- To change a Secret or ConfigMap's values, the detail panel's data editor
  sends only the keys you changed ([Secret and ConfigMap data](../reference/app/data.md)).

## Create objects from YAML

**+ Create** in the toolbar opens an editor for new objects: one or many
documents, from a template for the current kind, a file you open, or a file
you drop on it. nauvi validates everything with a server dry run first and
lists the result per object.

From a terminal, `nauvi apply -f file.yaml` does the same: a dry run first,
and nothing is applied if any object fails
([`nauvi apply`](../reference/cli/actions.md#nauvi-apply)).
