# 0013 JSR Starter Runtime And Fresh Gate

## Status

Completed on 2026-04-15.

## Goal

Make freshly initialized Superstructure starter apps run from published JSR packages, avoid local
platform-root wiring, and pass `superctl gate`, `superctl test`, and `superctl audit` without
hand-editing the scaffold.

## Implementation Checklist

1. Update starter runtime scaffolding
   - [x] stop generating repo-local `scripts/start.ts` and `scripts/dev.ts`
   - [x] keep the downstream `deno task` contract while routing runtime startup through published
         Superstructure packages
2. Switch starter dependencies to released packages
   - [x] move starter imports to JSR package specifiers
   - [x] keep local sibling-repo links optional instead of required for fresh init
3. Generate manifest-driven defaults
   - [x] source built-in services and default server port from `superstructure.project.json`
   - [x] keep the starter surface and generated registries aligned with the manifest
4. Tighten repo-local quality flows
   - [x] scope git-aware gate and audit checks to the current project path
   - [x] avoid fresh-app failures caused by unrelated workspace changes
5. Refresh local setup and release docs
   - [x] add a repo-local `mise` bootstrap script
   - [x] keep README/bootstrap `superctl` version references in sync during release bumps

## Validation

- `deno task check`
- `deno test --config deno.json --allow-env --allow-read --allow-write --allow-run src/superctl.test.ts`

<!-- Reasoning Level: recommended=high, current=high -->
