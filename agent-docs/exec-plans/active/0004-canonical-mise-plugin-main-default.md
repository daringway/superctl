# 0004 Canonical Mise Plugin Main Default

## Goal

Move workspace apps off app-local `superctl` plugin copies and onto one canonical plugin owned by
`repos/superctl`, with committed app defaults pinned to `superctl = "main"`.

## Scope

1. Add `repos/superctl/mise-plugin/` using the mise tool plugin template hook structure.
2. Switch checked-in app `.mise.toml` files from `superctl = "local"` to `superctl = "main"`.
3. Repoint local helper scripts to the canonical plugin and move the opt-in local override into
   `mise.local.toml`.
4. Update root bootstrap so new local apps link the canonical plugin and install `superctl@main`.
5. Update `superctl doctor` and project docs so they no longer expect app-local `.mise-plugins`.

## Notes

- `local` remains supported through `SUPERCTL_ROOT`.
- App-local `.mise-plugins/superctl` copies are removed.
- `mise.local.toml` becomes the supported local-only override file for switching a repo to
  `superctl@local`.

<!-- Reasoning Level: recommended=medium, current=medium -->
