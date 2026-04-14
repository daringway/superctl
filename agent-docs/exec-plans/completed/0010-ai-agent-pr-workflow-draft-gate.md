# 0010 AI-Agent PR Workflow Draft Gate

## Status

Completed on 2026-04-13.

## Summary

Update `superctl` to scaffold the no-human-review PR workflow:

- draft PRs run only `Superctl Gate`
- ready PRs run the full named quality suite

## Validation

- `deno fmt src/scaffold.ts src/superctl.test.ts`
- `deno test -A src/superctl.test.ts`

<!-- Reasoning Level: recommended=medium, current=medium -->
