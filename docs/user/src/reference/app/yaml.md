# YAML editing and creating

## The YAML editor

`E` or `Y` on a row, **Edit YAML** in the row menu, the row's hover buttons
or the detail panel opens the object's YAML.
The editor follows the app's theme; its font size and tab size are in
[Settings](settings.md).

- **Review & save…** first runs your change on the server as a test and
  shows the diff; **Save** there applies it. Saving uses **server-side
  apply**.
- Messages (the test run, errors, conflicts) show in a bar above the text.
  After a save it reads "Saved at 14:02:11" until your next edit, and the
  save is in the notifications.
- The review names the tools whose fields the save takes over (kubectl
  apply, Helm, a Kubernetes controller); they may set them back the next
  time they run.
- If the object changed on the server while you edited, nauvi merges:
  changes to its status only (a rollout) don't get in the way. Changes to
  other fields put your edit on top of the latest version, for you to
  review and save again. A field that both you and someone else changed
  stops the save and names the field: **Reload (lose my edits)**, or
  **Compare with the latest** and save your version on purpose. An object
  that was deleted (and maybe created again) is never saved over.
- Secret values stay hidden until you reveal them.
- Closing a window or quitting with unsaved edits asks first: **Keep
  editing** or **Discard changes**.

[Edit a Deployment's YAML safely](../../how-to/edit-yaml.md) walks through it.

## Create from YAML

**+ Create** opens an editor for new objects:

- one or many documents;
- from a template for the current kind, a file you open, or a file you drop;
- validated with a server dry run first; the results are listed per object.
