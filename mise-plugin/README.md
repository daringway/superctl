# superctl mise plugin

Canonical `mise` tool plugin for `superctl`.

This plugin follows the
[mise tool plugin template](https://github.com/jdx/mise-tool-plugin-template) hook structure and is
the only supported plugin implementation for workspace apps.

## Supported versions

- `main`: build `superctl` from the `daringway/superctl` default branch
- `<tag>`: build `superctl` from a tagged GitHub archive, including release candidates like
  `0.1.3-rc1`
- `local`: build `superctl` from `SUPERCTL_ROOT`

## Development

```bash
cd repos/superctl/mise-plugin
mise plugin link --force superctl .
mise run test
```

## Workspace usage

```bash
mise plugin link --force superctl /absolute/path/to/repos/superctl/mise-plugin
mise install -f superctl@main
SUPERCTL_ROOT=/absolute/path/to/repos/superctl mise install -f superctl@local
```
