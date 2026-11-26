<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Shell completions

Tab completion for bash, zsh, fish, PowerShell and elvish.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi completions`

Print a shell completion script, e.g. `nauvi completions bash > ~/.local/share/bash-completion/completions/nauvi`.

```text
nauvi completions <SHELL>
```

| Argument | What it does |
| --- | --- |
| `<SHELL>` | One of `bash`, `elvish`, `fish`, `powershell`, `zsh` |
