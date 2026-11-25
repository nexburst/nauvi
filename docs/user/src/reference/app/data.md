# Secret and ConfigMap data

The detail panel of a Secret or ConfigMap lists its keys and lets you change
them without editing the whole YAML.

- **Secret values stay hidden** until you reveal one key.
- **Copy**, **edit**, **add** or **remove** keys, then **Save**. Only the
  changed keys are sent (a merge patch).
- If someone else changed the object meanwhile, you choose: reload, or save
  your keys over it.
- Binary values show as base64.
- Without permission to patch, or for an immutable object, the data is
  read-only.
- Annotations that copy a Secret (`last-applied-configuration`, kapp's
  original, any that repeat its values) are hidden like the values.

In the YAML editor, Secret values are hidden too until you reveal them
([YAML editing](yaml.md)). The CLI hides them unless you pass `--reveal`
(`nauvi yaml`, `nauvi get -o yaml|json`), and `nauvi mcp` never returns them.
