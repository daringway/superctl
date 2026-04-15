# 0005 JSR Starter Runtime And Fresh Gate

## Goal

Make freshly initialized Superstructure starter apps run from published JSR packages, avoid local
platform-root wiring, and pass `superctl gate`, `superctl test`, and `superctl audit` without
hand-editing the scaffold.

## Scope

1. Update `superctl init` to generate a starter that does not create repo-local `scripts/start.ts`
   or `scripts/dev.ts`.
2. Switch starter `deno.json` imports from sibling-repo paths to JSR package specifiers and refresh
   vulnerable dependency versions.
3. Generate a manifest-driven starter runtime configuration so built-in services and the default
   server port come from `superstructure.project.json`.
4. Add starter test coverage and relax git-scoped gate/audit behavior so a brand-new local app does
   not fail due to unrelated workspace changes or missing completed exec plans.

## Notes

- Starter apps should still expose the required repo-root `deno task` contract.
- The starter runtime should only request the built-in services it actually needs by default.

<!-- Reasoning Level: recommended=high, current=high -->
