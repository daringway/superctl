#!/usr/bin/env bash

set -euo pipefail

superctl_version="0.1.7"
deno_version="2.7.10"
mise_file=".mise.toml"
mise_local_file="mise.local.toml"
should_refresh_local_superctl=0

if ! command -v mise >/dev/null 2>&1; then
  cat >&2 <<'EOF'
mise is required but was not found on PATH.
Install it first: https://mise.jdx.dev/getting-started.html
EOF
  exit 1
fi

if [[ -e "${mise_file}" ]]; then
  cat >&2 <<EOF
${mise_file} already exists in $(pwd).
Refusing to overwrite an existing project toolchain file.
EOF
  exit 1
fi

cat > "${mise_file}" <<EOF
[tool_alias]
superctl = "github:daringway/superctl"

[tools]
deno = "${deno_version}"
superctl = "${superctl_version}"
EOF

find_local_superctl_root() {
  local current
  current="$(pwd)"

  while [[ "${current}" != "/" ]]; do
    if [[ -f "${current}/repos/superctl/deno.json" && -d "${current}/repos/superctl/mise-plugin" ]]; then
      printf '%s\n' "${current}/repos/superctl"
      return 0
    fi
    current="$(dirname "${current}")"
  done

  return 1
}

if [[ ! -e "${mise_local_file}" ]]; then
  if local_superctl_root="$(find_local_superctl_root)"; then
    cat > "${mise_local_file}" <<EOF
[tools]
superctl = "local"

[env]
SUPERCTL_ROOT = "${local_superctl_root}"
EOF
    should_refresh_local_superctl=1
  fi
fi

mise trust
mise install

if [[ "${should_refresh_local_superctl}" -eq 1 ]]; then
  SUPERCTL_ROOT="${local_superctl_root}" mise install -f superctl@local
  mise reshim superctl
fi

cat <<EOF
Created ${mise_file} with:
  deno = "${deno_version}"
  superctl = "${superctl_version}"

Installed the pinned toolchain for $(pwd).
EOF
