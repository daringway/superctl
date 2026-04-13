# 0007 Codeowners Baseline

## Status

Completed.

## Summary

Add a baseline GitHub `CODEOWNERS` file so repository ownership is explicit for pull request review
and policy flows.

## Implementation Checklist

1. Add repository ownership metadata
   - [x] add `.github/CODEOWNERS`
   - [x] assign the repository to `@daringway/autopilot`
2. Validation
   - [x] `deno run -A main.ts gate`

## Progress Notes

- 2026-04-13: added a baseline `.github/CODEOWNERS` file that assigns repository ownership to
  `@daringway/autopilot`.
