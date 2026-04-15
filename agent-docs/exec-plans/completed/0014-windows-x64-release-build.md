# 0014 Windows X64 Release Build

## Status

Completed.

## Goal

Add `windows-x64` to the GitHub release build matrix so tagged `superctl` releases publish a Windows
binary alongside the existing Linux and macOS assets.

## Scope

1. Update release workflow
   - [x] add the Windows target to `.github/workflows/release.yml`
   - [x] publish a `superctl_windows_x64.tar.gz` asset containing `superctl.exe`
2. Validation
   - [x] parse the updated workflow YAML successfully
   - [x] run `deno task ci:gate`

## Progress Notes

- 2026-04-15: added `x86_64-pc-windows-msvc` to the release matrix and aligned the published asset
  name with the existing platform naming scheme.
- 2026-04-15: confirmed the workflow YAML parses successfully and reran repo gate checks after
  adding this completed exec plan.
