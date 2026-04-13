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
current directory with a runnable Superstructure starter: `deno.json`, runtime scripts, a smoke test
under `tests/smoke/`, a GitHub Actions quality workflow, generated registries, and a default HTML
`site` surface so `superctl start` can serve a welcome page immediately.

`superctl gate` is the PR-quality and policy command. It runs format and lint checks, validates the
project structure contract, enforces the repo-root `tests/` layout policy, and enforces the
completed exec-plan rule. `superctl test` is test-only. It requires `test:unit` plus `test:e2e`, and
also runs optional `test:bruno` and `test:ai` tasks when the project defines them. `superctl
audit`
is security-only. It runs secret scanning and dependency vulnerability checks as a separate, more
expensive PR check.

## Install

Install from GitHub Releases with `mise`:

```bash
mise use -g github:daringway/superctl@0.1.2
mise install
```

Within the `autopilot-ai-dev` workspace, apps should link the canonical plugin under
`repos/superctl/mise-plugin` and keep their committed `.mise.toml` on `superctl = "main"`:

```bash
mise plugin link --force superctl /absolute/path/to/repos/superctl/mise-plugin
mise install -f superctl@main
```

For opt-in local CLI development against a sibling `superctl` checkout:

```bash
SUPERCTL_ROOT=/absolute/path/to/repos/superctl mise install -f superctl@local
```

## Development

```bash
mise install
deno task check
```

## Releases

`deno.json` is the source of truth for the `superctl` version. Use the release bump script to update
that version and emit the matching git tag name:

```bash
deno task release:bump -- bump patch
deno task release:bump -- bump minor --rc
deno task release:bump -- bump patch --tag
```

Release candidates use `-rc#` tags such as `0.1.3-rc1`. Re-running the same bump with `--rc`
increments the candidate number. Running the matching stable bump promotes the current release
candidate to its final tag, for example `0.1.3-rc2` -> `0.1.3`.

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
