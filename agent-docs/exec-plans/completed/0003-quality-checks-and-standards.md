# 0003 Quality Checks And Standards

## Status

Completed.

## Summary

Extend the GitHub Actions quality workflow so the repository and generated starter projects expose
explicit standards coverage for formatting, linting, and dependency auditing alongside the existing
`superctl gate`, `superctl test`, and `superctl audit` jobs.

## Implementation Checklist

1. Update workflow definitions
   - [x] add a dedicated standards job that runs `deno fmt --check .` and
         `deno lint --config deno.json .`
   - [x] keep explicit `superctl gate`, `superctl test`, and `superctl audit` quality jobs
   - [x] add an explicit `deno audit --level=high` step to the audit job
2. Keep generated projects in sync
   - [x] update the starter workflow template emitted by `superctl init`
   - [x] update test fixtures that encode the default workflow
3. Validation
   - [x] `deno fmt src/scaffold.ts src/superctl.test.ts`
   - [x] `deno task test:unit`
   - [x] `deno run -A main.ts audit`
   - [x] `deno run -A main.ts gate`

## Progress Notes

- 2026-04-12: added explicit standards coverage to the live and scaffolded quality workflows and
  updated the unit tests so the workflow contract stays aligned with the generated template.
