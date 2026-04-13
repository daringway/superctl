# 0005 Release Bump Script And RC Tags

## Status

Completed.

## Summary

Add a repo-local release bump workflow that keeps `deno.json` as the single source of truth,
supports semantic version bumps for `major`, `minor`, and `patch`, and supports release candidates
with `-rc#` tags.

## Implementation Checklist

1. Add release bump automation
   - [x] add testable release bump logic under `src/`
   - [x] add a `scripts/release.ts` entrypoint for repo operators
   - [x] support `major`, `minor`, and `patch` bumps
   - [x] support `--rc` release-candidate bumps and matching stable promotion
   - [x] support optional git tag creation for the resolved version
2. Document the workflow
   - [x] add a root `deno task release:bump`
   - [x] document stable and RC release usage in `README.md`
   - [x] document RC tags in the canonical `mise-plugin` README
3. Validation
   - [x] `deno test -A src/release.test.ts`
   - [x] `deno test -A src/superctl.test.ts`
   - [x] `deno task release:bump -- bump patch`

## Progress Notes

- 2026-04-13: added a release bump script that updates `deno.json`, computes semver and `-rc#` tags,
  and can create a matching git tag when requested.
- 2026-04-13: documented the release workflow in the repo README and the canonical `mise-plugin`
  README so tag-based installs stay aligned with the new versioning flow.
