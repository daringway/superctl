# 0010 AI-Agent PR Workflow Draft Gate

## Status

Completed on 2026-04-13.

## Summary

Update `superctl` to enforce and scaffold the no-human-review PR model:

- draft PRs run only `Superctl Gate`
- ready PRs run the full named quality suite
- protected `main` requires PRs and status checks, but not approvals, stale-review dismissal, or
  CODEOWNERS review
- native GitHub auto-merge stays disabled

## Validation

- `deno fmt src/github_repo_policy.ts src/scaffold.ts src/superctl.test.ts`
- `deno test -A src/superctl.test.ts`

<!-- Reasoning Level: recommended=medium, current=medium -->
