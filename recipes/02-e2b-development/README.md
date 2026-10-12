# Recipe 02: spec-first development in E2B

Use an existing local Pi session to settle the product and technical specifications,
then hand a frozen implementation job to a fresh Pi process in E2B. GHAI supplies
the selected model; the local CLI owns sandbox setup, result collection, cleanup,
and the separate publication step.

This is a **skill-led recipe**. It does not install a custom Pi extension or rewrite
the teammate's global Pi configuration. The local controller is intended for Linux
and macOS; the sandbox is Linux x64. Current offline checks were exercised on
Linux only. macOS and the live E2B/GHAI/GitHub path have not been qualified.

## What is included

- A trusted [Pi skill](skills/e2b-development/SKILL.md) for the local handoff.
- A deterministic CLI for planning, running, inspecting, cancelling, and explicitly
  publishing a job.
- A pinned E2B template definition and sandbox-only mise tool manifest.
- Product and technical specs for a first [conversational todo agent](specs/product.md).
  **The app is an implementation brief, not a preimplemented example.**
- Credential-free fixtures for the controller and failure paths. Fake E2B tests
  are not evidence of a successful live sandbox, MCP connection, or model run.

There is no automatic workflow, background queue, durable job resumption, automatic
whole-job retry, merge, or deployment. Installing dependencies, loading the skill,
planning a job, and running the default tests do not provision a sandbox or call a
model. Template building, execution, and publication each require an explicit live
command and the corresponding user authorization.

## 1. Prepare the local supervisor

Use the repository's pinned Node 24.21.0 and pnpm 12.11.2, plus Git. Install the
locked dependencies without package lifecycle scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
node recipes/02-e2b-development/cli.mjs doctor
```

Start the teammate's existing Pi with this skill for this session:

```sh
pi --skill ./recipes/02-e2b-development/skills/e2b-development
```

Then invoke `/skill:e2b-development` inside Pi. Keep the existing local GHAI model
and local Pi setup. The recipe uses an explicitly selected model definition from
an existing models file; it does not copy the local Pi home, auth file, extensions,
personal instructions, or unrelated MCP servers into E2B.

The remote runtime is separately pinned to Pi 1.1.0. It uses that version's native
MCP support. Context7 is required for API documentation; Exa is optional and
exposes only web search/fetch. The remote runner probes configured MCP connections
before starting inference. No third-party MCP adapter extension is needed.

## 2. Finish the specs before delegating

Review and complete both [product.md](specs/product.md) and
[technical.md](specs/technical.md). The initial brief is a small Cloudflare Agents
SDK app in `examples/todo-agent/` with conversational todo operations, explicit
deletion approval, persistence, two-tab synchronization, and fake-model tests.
It deliberately excludes authentication, public hosting, and deployment.

Resolve product decisions locally. Agree on acceptance checks, the exact GitHub
repository and base commit, allowed output paths, time limit, services, credentials,
and publication destination before handing off. Context7 documentation lookup is
part of implementation, not a substitute for a complete specification.

## 3. Create an offline plan

The following command uses names of environment variables, never credential
values. Set the required `GHAI_PI_BASE_URL` and `GHAI_PI_PRIMARY_MODEL` variables locally.
Replace the repository, existing models-file path, and base SHA
with the agreed values. The SHA must identify the exact authorized starting commit.
Run all commands from the repository root.

```sh
node recipes/02-e2b-development/cli.mjs plan \
  --models-file /path/to/existing/models.json \
  --model-env GHAI_PI_PRIMARY_MODEL \
  --base-url-env GHAI_PI_BASE_URL \
  --repo OWNER/REPOSITORY \
  --base-sha FULL_40_CHARACTER_COMMIT_SHA \
  --base main \
  --e2b-env USER_E2B_TOKEN \
  --ghai-env GHAI_API_KEY \
  --context7-env USER_CONTEXT7_TOKEN \
  --github-env USER_GITHUB_TOKEN \
  --job artifacts/todo-job
```

Add `--exa-env USER_EXA_TOKEN` only when Exa is part of the authorized job. The
E2B, Context7, GitHub, and Exa variable names above are examples chosen by the
operator. `GHAI_API_KEY` is the default GHAI source variable for this repository;
`--ghai-env` also accepts an explicitly chosen name. The default specs and
[environment manifest](environment.manifest.json) are included in the recipe.
Use `--product PATH`, `--technical PATH`, and `--manifest PATH` to select reviewed
alternatives. Budgets are frozen from the manifest, not separate CLI flags. The runner source
hash is frozen too; code changes require a new plan.
Review the resulting plan before live work.

Only public GitHub repositories are supported by this version. The repository is
verified as public before provisioning and cloned without a GitHub credential.
The supplied base SHA is checked after checkout. Publication goes to that same
repository; fork/private-repository workflows are not implemented.

The model must be an exact entry in `providers.ghai.models`, at the explicitly configured GHAI
base URL, using `openai-responses`. Explicit `contextWindow`, `maxTokens`,
`reasoning`, and text-capable `input` metadata are required. The controller requires configuration variables without hardcoded fallback values.
Only the selected endpoint host is added to sandbox egress. It copies
only allowlisted model metadata, including existing compatibility settings;
authentication fields, headers, executable interpolation, other providers, and
extensions are excluded. Prepare a nonsecret preset first if the local provider
is supplied only by an extension. Selecting a catalog entry does not prove live
account eligibility or protocol compatibility.

Keep credentials in the invoking process's environment through your existing
secret-management workflow. Do not place their values in arguments, specs, model
metadata, committed files, `.env` files, or the job directory.

| Credential         | Where it is used                               |
| ------------------ | ---------------------------------------------- |
| E2B                | Local controller/template builder only         |
| GHAI               | The remote Pi process, for the selected model  |
| Context7           | Remote native MCP connection for documentation |
| Exa, optional      | Remote native MCP connection for research      |
| GitHub publication | Local publication controller only              |

E2B and GitHub publication tokens are never supplied to remote Pi. GHAI and MCP
credentials are supplied for the remote command, not baked into the template.
Command-scoped environment variables are still readable by the sandbox agent and
its child processes. They are not a secret boundary against an agent with shell
access. Use suitably scoped, revocable credentials and approve the remote services
that receive code or queries. The GitHub publication credential needs repository
contents-write and pull-requests-write access for the named repository. Supply an
existing appropriately scoped credential; this recipe does not create one.

## 4. Build the template, when explicitly authorized

The sandbox tools are pinned independently of the workstation:

| Component     | Pin       |
| ------------- | --------- |
| mise          | 2026.10.8 |
| Node          | 24.21.0   |
| pnpm          | 12.11.2   |
| Pi            | 1.1.0     |
| Local E2B SDK | 2.55.0    |

The builder uses `template-tools/mise.toml` and its lockfile. It does not activate
mise on the teammate's machine. Inspect the template and bootstrap script before
approving a build. Building uses E2B and may incur charges; it is not an offline
verification step.

```sh
node recipes/02-e2b-development/template.mjs \
  --live \
  --name ghai-pi-dev \
  --api-key-env USER_E2B_TOKEN \
  --out artifacts/e2b-template-build.json
```

Use the actual successful build record, including both `templateId` and `buildId`.
The remote instance selects that specific build. Do not invent either ID or treat
a planned template as built. No live template build has been qualified for this recipe.

The starting E2B `pi` template alias is mutable. Its base OS and inherited Git
version are not independently pinned, even though the installed toolchain is
pinned and the bootstrap records installed versions. The build descriptor records
this limitation, hashes of the uploaded source files, and the returned build
identity. A reserved descriptor with `build-outcome-unknown` must be reconciled in
E2B before a newly authorized build; do not blindly repeat the command.

## 5. Run and inspect the implementation

After the concrete plan and paid execution have been authorized:

```sh
node recipes/02-e2b-development/cli.mjs run \
  --job artifacts/todo-job \
  --live \
  --template-build artifacts/e2b-template-build.json

node recipes/02-e2b-development/cli.mjs status --job artifacts/todo-job
```

The controller hands off frozen inputs, runs remote Pi, then independently invokes
`lint`, `typecheck`, `test`, and `build` package scripts in the sandbox app directory
before collecting the patch. These scripts still run in an agent-modifiable
workspace; passing them is evidence, not an independent security attestation.
The controller records cleanup separately from task success. Treat the patch,
model report, repository content, command output, and MCP responses as untrusted. Check the changed paths and independently review
whether the reported checks actually satisfy the specs before publication.

To request cleanup for a known job:

```sh
node recipes/02-e2b-development/cli.mjs cancel --job artifacts/todo-job --live
```

Cancellation is a live E2B cleanup request; `status` itself only reads local files.
An unidentified sandbox or failed cleanup remains an uncertainty to investigate.

The job directory contains local evidence, not a durable orchestration service.
A controller crash, network timeout, or unknown result may leave remote work or
billing unresolved. Inspect the recorded sandbox identity and E2B account before
authorizing another attempt. A fresh run is new paid work. Do not interpret a
missing patch, timeout, or local process exit as proof that nothing ran or billed.

## 6. Publish only after reviewing the result

Publication is separate from implementation. Once the exact repository, branch,
patch, and draft PR have been authorized:

```sh
node recipes/02-e2b-development/cli.mjs publish \
  --job artifacts/todo-job \
  --live
```

Before a write, the publisher checks patch hashes, applies the patch in a fresh
local worktree without running its code, validates allowed paths and file modes,
and screens for known credential patterns. It rejects symlinks/submodules, Pi
state, dependency directories, and credential/configuration files. These checks
do not establish that generated application code is safe.

This is the only publication step. It uses the locally held GitHub credential to
publish a branch and draft PR. It does not merge or deploy. If publication has an
unknown outcome, inspect GitHub before authorizing another write.

## Job artifacts and state

The plan creates a new mode-0700 job directory and mode-0600 files. An existing
job directory cannot be silently overwritten or replayed.

- `job.json`: job ID, repository/SHA, generated publication branch, selected model,
  credential variable names, frozen input hashes, checks, and limits
- `product.md`, `technical.md`, `environment.manifest.json`: frozen input copies
- `state.json`: local execution/publication state and separate cleanup result
- `changes.patch`: collected patch after successful execution and checks
- `result.json`: patch hash, check results, derived agent result, billing unknown

A normal successful run advances from `prepared` through provisioning, running,
and verification to `ready_to_publish`. Create-only, fsynced `run.reserved` and
`publish.reserved` records prevent concurrent dispatch and remain spent after
unknown outcomes; do not delete them to replay work. Pre-provisioning validation can stop as `blocked`. Creation uncertainty stops as `unknown`;
execution or verification failure stops as `failed`. Inspect both task status and
cleanup: a failed task can have a killed sandbox, and a successful patch can have
unconfirmed cleanup. Editing frozen inputs or the recorded job invalidates the
handoff. Publication advances through `publishing` to `completed`; an uncertain
publication stops at `publication_unknown` and requires manual reconciliation.
Local records are not tamper-proof attestations.

## Bounds, trust, and evidence

The default manifest allows results only under `examples/todo-agent/`, a
15-minute controller execution window after sandbox creation, 40 observed turns,
and a 2,000,000-byte patch. The sandbox lifecycle includes a two-minute cleanup
allowance beyond that window. These
are control/acceptance limits, not a promise of exactly 15 minutes of remote
billing. Changing the approved manifest requires a new reviewed plan.

- The time limit and output checks are operational controls, **not a hard currency
  cap**, request-count guarantee, or account budget. Zero-valued model cost fields
  are display placeholders, and `actualBillingUsd` stays `null`. Multi-turn coding
  and MCP work differ from recipe 01's narrowly bounded one-call review transport.
- There is no automatic whole-job retry. Individual SDK/MCP operations may have
  their own retry behavior; this recipe does not claim exactly-once provider work.
- The sandbox separates remote work from the workstation. It does not make model
  instructions trustworthy or prevent the agent from reading its supplied secrets.
  An allowed output path is not an OS-level restriction on shell activity.
- Logs are derived, sanitized records. Raw model, command, and provider logs are
  not intentionally retained as controller artifacts. Sanitization is not a
  guarantee against every embedded secret or confidential source passage.
- Review outputs before sharing them. Keep `artifacts/` untracked and do not
  publish local Pi state, secrets, or raw private prompts.
- Version pins make inputs inspectable; they do not prove supply-chain safety or
  live service compatibility. Runtime template build evidence and successful live
  execution are separate from the checked-in definition and offline fixtures.

The repo's [security document](../../docs/security.md) describes recipe 01's
read-only CI contract. Its one-POST accounting and disabled-tool guarantees do not
apply to this coding recipe. See [architecture](../../docs/architecture.md) and
[primary references](../../docs/sources.md) for the broader composition model.

Gateway base URLs, hostnames, and model IDs are local runtime configuration, not
public examples. Keep actual values in local environment variables or repository
secrets. Repository secrets are not automatically available on a workstation. Output screening rejects the selected gateway
host/base URL and model ID if they appear in a proposed public patch.
