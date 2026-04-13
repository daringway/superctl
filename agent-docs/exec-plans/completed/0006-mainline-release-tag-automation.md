# 0006 Mainline Release Tag Automation

## Status

Completed.

## Goal

Align `superctl` release automation around canonical `v`-prefixed tags and prevent merged pull
requests from reusing an already-released `deno.json` version.

## Scope

1. Update release helpers and docs
   - [x] return and print `v${deno.json.version}` as the release tag
   - [x] document `v`-prefixed release tags in repo docs
2. Add PR version validation
   - [x] fail pull requests when `deno.json.version` already has a matching `v` or legacy bare tag
3. Add post-merge tag creation
   - [x] create and push `v${deno.json.version}` when a PR merges into `main`
   - [x] fail loudly if the tag already exists or appears concurrently
4. Validation
   - [x] `deno test -A src/release.test.ts`
   - [x] inspect workflow YAML for trigger and guard correctness

## Progress Notes

- 2026-04-13: updated release helpers, tests, and docs so canonical release tags are `v`-prefixed.
- 2026-04-13: added a PR workflow job that blocks reused `deno.json` versions when either canonical
  or legacy matching tags already exist.
- 2026-04-13: added a post-merge workflow that tags merged `main` commits with
  `v${deno.json.version}` and fails if the tag already exists or is created concurrently.
