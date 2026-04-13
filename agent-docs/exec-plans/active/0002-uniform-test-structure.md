# 0002 Uniform Test Structure

## Status

Completed.

## Goal

Align `superctl` with the shared testing contract by:

- keeping repo-root `tests/` only for smoke, e2e, fixtures, harnesses, and other non-unit suites
- moving unit tests next to `src/` ownership
- enforcing the layout through `gate` and `doctor`, not `test`

## Implementation Checklist

1. Move repo tests
   - [x] move unit coverage out of repo-root `tests/`
   - [x] keep CLI smoke coverage under `tests/smoke/`
2. Update tasks and scaffolding
   - [x] update repo task globs for the new locations
   - [x] update downstream scaffold templates to emit `tests/smoke/runtime_smoke_test.ts`
3. Add enforcement
   - [x] add project layout checks for disallowed root `bruno/`, `e2e/`, and `test/`
   - [x] allow repo-root `tests/{e2e,db,bruno,smoke,fixtures,harness}/**`
4. Validation
   - [x] `deno task test:unit`
   - [x] `deno task test:e2e`

## Progress Notes

- 2026-04-12: opened the layout-standardization follow-up so `superctl` scaffolding, doctor, and
  gate can enforce the same split used by maintained downstream repos.
- 2026-04-12: moved the repo unit suite to `src/superctl.test.ts`, narrowed repo-root `tests/` to
  `tests/smoke/`, updated local tasks plus starter templates, and added layout enforcement to `gate`
  and `doctor`.
- 2026-04-12: validation passed for `deno task test:unit` and `deno task test:e2e`.

<!-- Reasoning Level: recommended=medium, current=medium -->
