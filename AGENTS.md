# AGENTS.md

## Purpose

This repository owns the `superctl` CLI for Superstructure project scaffolding, policy checks,
application verification, and security audit flows.

## Read Order

1. `README.md`
2. `agent-docs/README.md`
3. active exec plans in `agent-docs/exec-plans/active/`

## Local Rules

- `agent-docs/` is the canonical project-local guidance folder.
- Track substantial work in `agent-docs/exec-plans/active/` and move completed work to
  `agent-docs/exec-plans/completed/`.
- Use `deno run -A main.ts gate` for repo-local PR-policy checks.
- Keep `verify` test-only.
- Keep `audit` security-only.
