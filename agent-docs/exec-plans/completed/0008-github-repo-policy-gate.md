# 0008 GitHub Repo Policy Gate

## Status

Completed.

## Summary

Extend `superctl gate` so it validates the live GitHub repository policy expected for maintained
repos, with `main` as the required protected default branch:

- baseline `CODEOWNERS` ownership for `@daringway/autopilot`
- native repo merge settings for squash-only auto-merge flow
- exact `main` branch protection with one approval, stale-review dismissal, CODEOWNERS review, and
  the exact required checks declared by the repo's quality workflow

## Validation

- `deno test -A src/superctl.test.ts`
- `deno run -A main.ts gate`

<!-- Reasoning Level: recommended=medium, current=medium -->
