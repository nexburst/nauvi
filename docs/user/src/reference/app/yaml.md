# YAML editing and creating

## The YAML editor

`E` or `Y` on a row, or **Edit** in the detail panel, opens the object's YAML.
The editor follows the app's theme; its font size and tab size are in
[Settings](settings.md).

- Saving uses **server-side apply**. After saving, nauvi tells you which
  fields it took over from other field managers (for example from `kubectl`
  or a controller).
- Secret values stay hidden until you reveal them.
- Closing a window or quitting with unsaved edits asks first: **Keep
  editing** or **Discard changes**.

[Edit a Deployment's YAML safely](../../how-to/edit-yaml.md) walks through it.

## Create from YAML

**+ Create** opens an editor for new objects:

- one or many documents;
- from a template for the current kind, a file you open, or a file you drop;
- validated with a server dry run first; the results are listed per object.
