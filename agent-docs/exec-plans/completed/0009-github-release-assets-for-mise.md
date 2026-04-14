# 0009 GitHub Release Assets For Mise

## Status

Completed.

## Goal

Make `superctl` publish GitHub Releases with binary assets whenever a merged pull request tags a new
`v*` version on `main`, so versioned `mise` installs can consume release assets instead of relying
on source-only tags.

## Scope

1. Rework release automation
   - [x] keep `release.yml` usable for tag pushes and manual runs
   - [x] make the post-merge tag workflow trigger the binary release flow directly
2. Update install docs
   - [x] document that GitHub-backed `mise` installs require published releases, not bare tags
3. Validation
   - [x] parse the updated workflow YAML successfully
   - [x] verify the tag workflow exports the release tag into the reusable release workflow

## Progress Notes

- GitHub Actions pushes performed with `GITHUB_TOKEN` do not reliably trigger downstream workflows
  in the way this repo needs for release publication.
- The current failure mode leaves a valid `v*` git tag with no GitHub Release, which breaks `mise`
  GitHub-backend installs.
- 2026-04-13: updated `release.yml` so it can be called directly with a specific tag name while
  still supporting tag pushes and manual dispatch.
- 2026-04-13: updated `tag-on-main-merge.yml` to export the computed release tag and invoke the
  reusable release workflow after the tag push succeeds.
- 2026-04-13: aligned install docs in `repos/superctl` and `apps/daringway-website-2` with the
  current released-version pin and the requirement for published GitHub Releases.

<!-- Reasoning Level: recommended=medium, current=medium -->
