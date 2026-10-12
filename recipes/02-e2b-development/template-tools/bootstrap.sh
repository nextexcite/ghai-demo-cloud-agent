#!/usr/bin/env bash
set -euo pipefail

# This installer is a template build step, never a workstation setup script.
if [[ ${1:-} != --sandbox-template-build || $# != 1 ]]; then
  printf '%s\n' 'Refusing to install outside an explicit sandbox template build.' >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 || $(id -u) != 0 ]]; then
  printf '%s\n' 'This template requires Linux x64 and the template builder root user.' >&2
  exit 2
fi

readonly root=/opt/ghai-delegation
readonly mise_version=2026.10.8
readonly mise_sha256=c72477ae6c3a8e7d817a322f43da70e4643e75ee5c21265f1c19c894273b7428
readonly mise_url="https://github.com/jdx/mise/releases/download/v${mise_version}/mise-v${mise_version}-linux-x64"

for command in curl sha256sum git; do
  command -v "$command" >/dev/null || { printf 'Missing base dependency: %s\n' "$command" >&2; exit 1; }
done

mkdir -p "$root/bin" "$root/build-home" "$root/mise" "$root/packages"
chmod 700 "$root/build-home"
mkdir -p "$root/build-home/xdg"/{config,cache,data,state,runtime}
chmod 700 "$root/build-home/xdg/runtime"
: > "$root/build-home/npm-user.conf"
: > "$root/build-home/npm-global.conf"
download=$(mktemp "$root/mise/download.XXXXXX")
trap 'rm -f "$download"' EXIT
curl --disable --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
  --location --connect-timeout 15 --max-time 180 "$mise_url" -o "$download"
printf '%s  %s\n' "$mise_sha256" "$download" | sha256sum -c -
install -m 755 "$download" "$root/bin/mise"

# Start from a clean environment. Never read inherited HOME, npmrc, mise config,
# tokens, shell hooks, or proxy settings from the base template during install.
env -i PATH="$root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="$root/build-home" \
  XDG_CONFIG_HOME="$root/build-home/xdg/config" \
  XDG_CACHE_HOME="$root/build-home/xdg/cache" \
  XDG_DATA_HOME="$root/build-home/xdg/data" \
  XDG_STATE_HOME="$root/build-home/xdg/state" \
  XDG_RUNTIME_DIR="$root/build-home/xdg/runtime" \
  MISE_DATA_DIR="$root/mise/data" MISE_CACHE_DIR="$root/mise/cache" \
  MISE_CONFIG_DIR="$root/mise/config" MISE_STATE_DIR="$root/mise/state" \
  MISE_SYSTEM_CONFIG_DIR="$root/mise/system" MISE_CEILING_PATHS="$root" \
  MISE_TRUSTED_CONFIG_PATHS="$root/template-tools" \
  MISE_NO_HOOKS=1 MISE_NO_ENV=1 MISE_YES=1 \
  NPM_CONFIG_USERCONFIG="$root/build-home/npm-user.conf" \
  NPM_CONFIG_GLOBALCONFIG="$root/build-home/npm-global.conf" \
  npm_config_ignore_scripts=true npm_config_audit=false npm_config_fund=false \
  bash --noprofile --norc <<'INSTALL'
set -euo pipefail
readonly root=/opt/ghai-delegation
cd "$root/template-tools"
"$root/bin/mise" install --locked
node_path=$("$root/bin/mise" which node)
ln -s "$node_path" "$root/bin/node"
pnpm_install=$("$root/bin/mise" where npm:pnpm)
pnpm_path=$(node "$root/template-tools/resolve-pnpm.mjs" "$pnpm_install")
ln -s "$pnpm_path" "$root/bin/pnpm"
test "$(node --version)" = v24.21.0
test "$(pnpm --version)" = 12.11.2
cd "$root/packages"
pnpm install --frozen-lockfile --ignore-scripts

# The exact Pi package and its entire dependency graph come from the root
# pnpm-lock.yaml. Shadow the mutable base template's Pi without touching it.
cat > "$root/bin/pi" <<'PI'
#!/bin/sh
exec /opt/ghai-delegation/bin/node /opt/ghai-delegation/packages/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$@"
PI
chmod 755 "$root/bin/pi"
# Explicit template build only: install the browser from the pinned package.
ln -s "$root/packages/node_modules/.bin/agent-browser" "$root/bin/agent-browser"
HOME="$root/browser-home" agent-browser install --with-deps
chrome=$(find "$root/browser-home/.agent-browser/browsers" -type f -name chrome -print -quit)
test -n "$chrome"
ln -s "$chrome" "$root/bin/chrome"
"$root/bin/chrome" --version >/dev/null

node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const pi = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"));
if (pi.version !== "1.1.0") throw new Error("Unexpected Pi package version");
writeFileSync("/opt/ghai-delegation/toolchain.json", JSON.stringify({
  node: process.versions.node,
  pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  pi: pi.version,
  agentBrowser: JSON.parse(readFileSync("node_modules/agent-browser/package.json", "utf8")).version,
  chrome: execFileSync("/opt/ghai-delegation/bin/chrome", ["--version"], { encoding: "utf8" }).trim(),
  mise: execFileSync("mise", ["--version"], { encoding: "utf8" }).trim(),
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  architecture: process.arch,
  gitSource: "inherited from the mutable official pi base template"
}, null, 2) + "\n", { mode: 0o644 });
'
INSTALL

# Build HOME is never the runtime HOME. Do not preserve caches or auth files.
rm -rf "$root/build-home" "$root/mise/cache" "$root/mise/state"
chmod -R go-w "$root"
