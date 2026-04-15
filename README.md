# superctl

Standalone CLI for Superstructure projects.

`superctl` owns project-facing developer and operator workflows. It does not own the shared runtime
or Superstructure framework packages.

Current parity-first commands:

```bash
superctl init
superctl add service <name>
superctl add surface <name>
superctl build
superctl start
superctl dev
superctl audit
superctl gate
superctl test
superctl doctor
```

`doctor` checks project configuration without running the full test pipeline. `init` bootstraps the
current directory with a runnable Superstructure starter: `deno.json`, a smoke test under
`tests/smoke/`, a GitHub Actions quality workflow, generated registries, and a default HTML `site`
surface so `superctl start` can serve a welcome page immediately. Starter `start` and `dev` tasks
run through the published Superstructure runtime CLI instead of generated `scripts/start.ts` and
`scripts/dev.ts`.

`superctl gate` is the PR-quality and policy command. It runs format and lint checks, validates the
project structure contract, enforces the repo-root `tests/` layout policy, and enforces the
completed exec-plan rule. `superctl test` is test-only. It requires `test:unit` plus `test:e2e`, and
also runs optional `test:bruno` and `test:ai` tasks when the project defines them. `superctl
audit`
is security-only. It runs secret scanning and dependency vulnerability checks as a separate, more
expensive PR check.

For this `superctl` repository itself, use the repo-local Deno entrypoints in CI and local PR
validation: `deno task ci:gate`, `deno task ci:test`, and `deno task ci:audit`.

## Install

For initial project setup, use the one-liner first. It checks that `mise` is installed, creates
`.mise.toml`, runs `mise trust`, and installs the pinned toolchain:

```bash
curl -fsSL https://raw.githubusercontent.com/daringway/superctl/main/scripts/setup-mise-project.sh | bash
```

To set it up manually, commit a repo-local `.mise.toml` like:

```toml
[tool_alias]
superctl = "github:daringway/superctl"

[tools]
deno = "2.7.10"
superctl = "0.1.6"
```

Then install the pinned toolchain from the project root:

```bash
mise trust
mise install
```

This keeps both `deno` and `superctl` repo-local instead of doing a global install. Commit the
`.mise.toml` pin with the project.

When developing inside a workspace that already contains a local `repos/superctl` checkout, add a
repo-local `mise.local.toml` override so the project uses the local source build:

```toml
[tools]
superctl = "local"

[env]
SUPERCTL_ROOT = "/absolute/path/to/repos/superctl"
```

The bootstrap script writes this override automatically when it detects the standard workspace
layout.

The plugin backend consumes published GitHub Releases, not bare git tags. Merged pull requests to
`main` create the matching `v*` tag and publish the release assets automatically. On fresh machines,
export `GITHUB_TOKEN` before `mise install` to avoid GitHub API rate-limit failures.

## Development

```bash
mise install
deno task check
deno task ci:gate
deno task ci:test
deno task ci:audit
```

## Releases

`deno.json` is the source of truth for the `superctl` version. Use the release bump script to update
that version, rewrite the README and bootstrap script to the same version, and emit the matching git
tag name:

```bash
deno task release:bump -- bump patch
deno task release:bump -- bump minor --rc
deno task release:bump -- bump patch --tag
```

Release candidates use `v`-prefixed `-rc#` tags such as `v0.1.3-rc1`. Re-running the same bump with
`--rc` increments the candidate number. Running the matching stable bump promotes the current
release candidate to its final tag, for example `v0.1.3-rc2` -> `v0.1.3`.

Git release tags are canonical `v`-prefixed versions derived from `deno.json`, for example `v0.1.2`
and `v0.1.3-rc1`.

## Scope

`superctl` owns:

- project initialization
- project scaffolding
- project gate, test, and audit
- wrapper commands that delegate to repo-local `deno task build/start/dev`
- future project init, upgrades, and AUTOPILOT connection flows

`superctl` does not own:

- Superstructure runtime/framework packages
- shared auth, permissions, config, contracts, or runtime code
- superstructure JSR package publishing flows
