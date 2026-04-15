# 0011 Direct Superctl GitHub Checks

## Status

Completed on 2026-04-13.

## Summary

Update `superctl` workflow validation so maintained repos can use repo-installed `superctl` commands
in GitHub Actions instead of vendoring `.github/tools/superctl`:

- accept `superctl gate`
- accept `superctl test` or `superctl verify`
- accept `superctl audit`
- keep the older vendored `main.ts` pattern valid for repos that have not migrated yet

## Validation

- `deno test -A src/superctl.test.ts`

<!-- Reasoning Level: recommended=medium, current=medium -->
