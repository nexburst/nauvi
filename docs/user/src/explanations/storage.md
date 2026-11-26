# What nauvi stores, and where

nauvi keeps its own settings and state in a few folders. It never writes your
kubeconfig files.

## The app's folders

| What | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Config | `~/.config/com.nauvi.app/` | `~/Library/Application Support/com.nauvi.app/` | `%APPDATA%\com.nauvi.app\` |
| Logs | `~/.local/share/com.nauvi.app/logs/` | `~/Library/Logs/com.nauvi.app/` | `%LOCALAPPDATA%\com.nauvi.app\logs\` |

## In the config folder

| File | What it holds |
| --- | --- |
| `settings.json` | Your settings and what nauvi remembers ([Settings](../reference/app/settings.md#what-nauvi-remembers)) |
| `kubeconfigs/<name>.yaml` | Kubeconfigs you pasted into the catalog (mode 0600) |
| `exec-approvals.json` | Your answers about login commands of added kubeconfigs, per source and command |
| `proxies.json` | Per-cluster proxies, with their passwords (readable only by you) |

**The watch** (the calm streak in the title bar) is kept in the app's local
storage, per context.

## Skill files for Ask AI

On the first Ask AI with a CLI, nauvi writes the `nauvi` skill to
`~/.claude/skills/nauvi/SKILL.md` (Claude Code) or
`~/.agents/skills/nauvi/SKILL.md` (Codex, Gemini CLI), and updates it when
nauvi updates. **Settings → AI** lists and removes them
([Ask AI](../reference/app/ask-ai.md#the-nauvi-skill)).

## In the data folder

The matching kubectl, if you downloaded one
([The dock and terminals](../reference/app/dock.md#matching-kubectl)).

## Temporary files

A local terminal, an Ask AI tab or a Helm action on a context of an added
kubeconfig writes a temporary kubeconfig, `nauvi-shell-*.yaml`, in the system
temp directory. It may hold that context's credentials. On Linux and macOS
only you can read it (mode 0600). It is deleted when the tab closes, the
command ends or the app exits, and after a crash on the next start (except
on Windows, where leftover files can be deleted by hand).

## Logs

`nauvi.log`, rotated at 2 MiB with 3 files kept, readable only by you on
Linux and macOS. Secret-looking text is masked, but check the log before you
share it.

## Removing everything

Uninstalling keeps the folders above. Delete them by hand to remove your
settings; on macOS, `brew uninstall --zap --cask nauvi` does it.
