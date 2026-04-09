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
superctl verify
superctl doctor
```

`doctor` checks project configuration without running the full verification pipeline. `init`
bootstraps the current directory with a runnable Superstructure starter: `deno.json`, runtime
scripts, a smoke test, a GitHub Actions quality workflow, generated registries, and a default HTML
`site` surface so `superctl start` can serve a welcome page immediately.

## Install

Install from GitHub Releases with `mise`:

```bash
mise use -g github:daringway/superctl@0.1.2
mise install
```

For local sibling-repo development before a release exists:

```bash
deno run -A main.ts --help
```

## Development

```bash
mise install
deno task check
```

## Scope

`superctl` owns:

- project initialization
- project scaffolding
- project verification
- wrapper commands that delegate to repo-local `deno task build/start/dev`
- future project init, upgrades, and AUTOPILOT connection flows

`superctl` does not own:

- Superstructure runtime/framework packages
- shared auth, permissions, config, contracts, or runtime code
- superstructure JSR package publishing flows
