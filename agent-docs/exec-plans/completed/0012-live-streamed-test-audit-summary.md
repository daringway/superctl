# 0012 Live-Streamed Test And Audit Summaries

## Status

Completed on 2026-04-13.

## Goal

Keep the end-of-run `superctl test` and `superctl audit` summaries while restoring realtime child
process output and preserving stdout/stderr lines as they are emitted.

## Implementation Checklist

1. Add a reusable streaming capture helper
   - [x] mirror child stdout/stderr to the terminal in realtime
   - [x] retain captured bytes for summary metric extraction
2. Wire the helper into test and audit runners
   - [x] replace buffered `.output()` capture in `verify.ts`
   - [x] replace buffered `.output()` capture in `audit.ts`
3. Add regression coverage
   - [x] cover mirrored stdout/stderr capture without touching unrelated test files
4. Release
   - [x] run targeted validation
   - [x] bump patch version and create the matching git tag

## Validation

- `deno test --config deno.json --allow-env --allow-read --allow-write --allow-run src/command_summary.test.ts`
- `deno task test:unit`
- `deno task test:e2e`

<!-- Reasoning Level: recommended=medium, current=medium -->
