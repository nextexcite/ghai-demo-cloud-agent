# Sandbox toolchain

These files are inputs to `../template.mjs`. They do not activate mise, alter a
workstation's Node or Pi, or install anything merely by importing the template.
The bootstrap refuses to run without `--sandbox-template-build` and Linux x64
root. It is intended to run only inside E2B's template builder.

## Pins and scope

- mise `2026.10.8`, official Linux x64 executable, SHA-256
  `c72477ae6c3a8e7d817a322f43da70e4643e75ee5c21265f1c19c894273b7428`.
  The digest was read from the official release's `SHASUMS256.txt` and checked
  against the downloaded binary. The bootstrap checks it before execution. It
  does not execute the rolling `mise.run` installer.
- Node `24.21.0`, `core:node`, with its official archive URL and SHA-256 in
  `mise.lock`.
- pnpm `12.11.2`, `npm:pnpm`, with an integrity-locked dependency graph in the
  generated `.mise/locks/npm-pnpm/12.11.2/` sidecar. Both sidecar files are
  required; do not format or hand-edit their bytes. The main lock authenticates
  them with a digest. This uses the official npm wrapper and its exact native
  optional dependencies, without weakening integrity verification.
  `allow_builds = false` explicitly disables package lifecycle scripts. The
  optional `@pnpm/exe.linux-x64` package supplies the integrity-locked native
  executable. `resolve-pnpm.mjs` checks the wrapper/dependency versions, confines
  resolution to the install directory and requires an executable ELF file.
  The template links that binary directly; it does not run `install.js` or the
  wrapper's fallback downloader. This also avoids mise's pnpm-12 shim treating
  the wrapper's shebang-less shell placeholder as JavaScript.
- Pi `1.1.0`, installed from the repository's exact `package.json` and
  `pnpm-lock.yaml`. Reusing that lock pins Pi's transitive graph too. Package
  lifecycle scripts are disabled. It also installs the other locked development
  dependencies; no repository code, private specs, credentials, or Pi state are
  copied into the template.

The mise lock covers **Linux x64 only**. The existing Linux/macOS workstation
continues to use its own Pi; this is not a replacement workstation installer.
The runtime uses explicit binaries in `/opt/ghai-delegation/bin`, with Pi's
wrapper calling the pinned Node directly. mise config, data, cache and state
are isolated from the base image's user configuration. Runtime settings use the
sandbox user's separate `.ghai-mise` directories; no shell activation is needed.

The base is E2B's documented `pi` alias. That alias, its OS packages and its git
version are **mutable**. This recipe records `baseBuildId: null` and
`baseIsMutable: true`; it makes no independently reproducible base-image claim.
The builder records installed versions, including inherited git, in
`/opt/ghai-delegation/toolchain.json`. A successful custom build produces an
immutable E2B `buildId` for subsequent provenance checks. Merely having the
custom template's name or `templateId` does not pin its current build.

## Explicit future build

Offline checks do not establish a successful E2B template build or sandbox
provisioning. An authorized maintainer can choose an existing E2B credential environment variable
and explicitly request a live, potentially billable build:

```sh
node recipes/02-e2b-development/template.mjs \
  --live --name ghai-pi-dev --api-key-env E2B_API_KEY \
  --out artifacts/e2b-template-build.json
```

The script does not load `.env` files or infer which variable contains the
credential. It pins the E2B SDK to `2.55.0` and targets the official
`https://api.e2b.app` endpoint, ignoring ambient domain/API/debug overrides.
Source bytes are staged and hashed before upload. Only the eight allowlisted
toolchain inputs are uploaded. There is no Pi start command: the controller
uploads the trusted runner and approved inputs only after sandbox creation.

Before the build request, the output path is exclusively reserved with unknown
status. SDK API retries are disabled. Success records the returned `templateId`
and immutable `buildId`; failures or interruptions retain the unknown record.
Inspect E2B's dashboard before authorizing another build or choosing another
output path. Neither a local error nor an unknown record proves that E2B did no
work or incurred no charge. The template build record is separate from model
request accounting.

## Offline verification

`tests/e2b-template.test.mjs` serializes the installed SDK's real template,
checks pins and guards, and replaces only the live build call with deterministic
fixtures. It verifies both successful and unknown descriptor handling. Shell
syntax and refusal outside an explicit build are also tested. The pinned mise
binary and Linux Node/pnpm lock were additionally verified with an isolated
local installation, with pnpm lifecycle scripts blocked and its native binary
resolved directly. The original wrapper remained an unmodified text placeholder.
This does not qualify the E2B image build or live runtime.

## Primary references

- [E2B's Pi template](https://docs.e2b.dev/agents/pi)
- [E2B template SDK](https://docs.e2b.dev/template/quickstart)
- [mise manual installation](https://mise.jdx.dev/installing-mise.html)
- [Pinned official release checksums](https://github.com/jdx/mise/releases/download/v2026.10.8/SHASUMS256.txt)
- [mise lockfiles](https://mise.jdx.dev/dev-tools/mise-lock.html)
- [mise environment isolation](https://mise.jdx.dev/configuration/environment-variables.html)

API calls and options were checked against the installed `e2b@2.55.0` types and
real offline SDK serialization, rather than assuming the latest web examples
match the package pin.

## Browser QA tooling

The template also installs the root-lockfile-pinned agent-browser 0.39.0 package
and, only during the explicit build, downloads Chrome for Testing with its
installer. That installer selects current stable Chrome: the browser binary is
not independently version-pinned. Its actual version is recorded in the sandbox
`/opt/ghai-delegation/toolchain.json`. A fixed executable symlink lets each smoke
run use a fresh browser HOME without downloading again. No browser is installed
on the teammate's workstation by this recipe. The template remains unbuilt and
browser behavior is offline-fixture-tested only.
