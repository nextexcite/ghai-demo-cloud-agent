# Recipe 02: local specs, E2B implementation

Use your existing local Pi to review the two short specs, then delegate their
implementation to remote Pi in E2B. The target is a classic local **TanStack todo
app** with due dates, in-app reminders, and configurable assignees. There is no
chat or model in the app itself. The app is a brief for the coding agent, not
prebuilt source in this repository.

## Setup: `.env` + direnv, then your existing Pi

From the repository root, copy [env.example](../../env.example), fill the blank
values in a local editor, review the one-line `.envrc`, and allow direnv:

```sh
cp -n env.example .env
chmod 600 .env
${EDITOR:-vi} .env
direnv allow
pnpm install --frozen-lockfile --ignore-scripts
direnv exec . pi --skill ./recipes/02-e2b-development/skills/e2b-development
```

Invoke `/skill:e2b-development` and ask Pi to implement the included todo specs.
Pi handles the short commands below and asks before paid cloud work or publication.
Use the repository's pinned Node/pnpm and installed [direnv](https://direnv.net/).
`direnv exec` also works before a shell hook has refreshed the current prompt. This setup changes no global Pi config.

**Put your E2B key in `E2B_API_KEY` inside `.env`.** Both the template builder and
controller read that same variable after direnv loads it. There is no key flag.
The key stays on the workstation; it is never a template file, job artifact, or
sandbox environment variable. `.env` is ignored. Never paste keys in chat or args.

| Variable                | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `E2B_API_KEY`           | Local E2B build, creation, and cleanup             |
| `GHAI_API_KEY`          | Remote coding Pi's model access                    |
| `GHAI_BASE_URL`         | Privately configured model endpoint                |
| `GHAI_PI_PRIMARY_MODEL` | Exact model ID in your existing GHAI preset        |
| `GHAI_DECISION_MODEL`   | Optional; defaults to `jev-latest`                 |
| `CONTEXT7_API_KEY`      | Remote coding Pi's documentation MCP access        |
| `GH_TOKEN`              | Local GitHub publisher, only needed at publication |

Use existing scoped credentials; this recipe creates none. GitHub publication
needs contents-write and pull-requests-write for the chosen repository. Repository
secrets do not automatically populate your workstation. Remote Pi has Context7 as
its only MCP server; your existing local Pi home/configuration is not uploaded.

## 2. Review the specs and prepare a plan

Review [product.md](specs/product.md) and [technical.md](specs/technical.md) with
local Pi before cloud work. They specify a React + TanStack Router + Vite app in
`examples/todo-app/`, local browser persistence, a streamlined list UI, optional
due/reminder times, and an allowed/default assignee parameter. Expiry means
visibly overdue, never automatic deletion. Reminders work while the page is open
and catch up on reopening; there is no background delivery service.

The skill prepares the job with:

```sh
pnpm recipe2 plan
```

Defaults come from this checkout's GitHub `origin` and current `HEAD`, your existing
Pi agent directory's `models.json` (normally `~/.pi/agent/models.json`), and
`artifacts/todo-job`. Set optional `PI_MODELS_FILE` in `.env` only when the preset
file lives elsewhere. Review the printed repository, SHA and limits before handoff.
Plan is offline: it freezes both specs, the manifest, runner, model and variable names.

The model must exactly match `providers.ghai.models`, the configured endpoint and
`openai-responses`; explicit `contextWindow`, `maxTokens`, `reasoning`, and text
input metadata are required. Only nonsecret preset metadata is copied. If the
provider exists only in an extension, export a nonsecret models file first.

Only public GitHub repositories are supported. The clone carries no GitHub token.
A completed or uncertain job cannot be replayed: review the prior outcome and use
an explicitly chosen new job directory for newly authorized work. See
`pnpm recipe2 --help` for overrides; ordinary setup needs no long flag list.

## 3. Build the template once, after authorization

This step uses E2B and can incur charges. Review the template/bootstrap first.

```sh
pnpm recipe2 build --live
```

The builder reads `E2B_API_KEY` from your local environment, installs the pinned
mise 2026.10.8 / Node 24.21.0 / pnpm 12.11.2 / Pi 1.1.0 / agent-browser 0.39.0 toolchain and Chrome, and records the
actual immutable template/build IDs in `artifacts/e2b-template-build.json`. The local E2B SDK is pinned to 2.55.0.
No credentials are baked into the template, and remote Pi starts only after
sandbox creation. The checked-in manifest is intentionally **unbuilt**; no live
build has been qualified. Do not invent IDs or reuse an unknown-outcome record.

The official base `pi` template is mutable. Its OS/Git are not independently
pinned; uploaded tool inputs are hashed and installed versions recorded. See the
[template details](template-tools/README.md) for reproducibility limits.

## 4. Run, inspect, and clean up

After reviewing the concrete plan and authorizing paid execution:

```sh
pnpm recipe2 run --live
pnpm recipe2 status
```

The controller runs this small fixed workflow:

1. Pi implements the frozen specifications.
2. Run `lint`, `typecheck`, `test`, and `build`; then trusted agent-browser smoke
   opens the app, adds a todo, checks it survives reload, and captures a temporary screenshot.
3. Our own SystemOne helper asks for `ready_for_review`, `repair`, or `ask_human`.
   It reuses `GHAI_BASE_URL` ending in `/v1`, appending `/systemone` once, and
   `GHAI_API_KEY`. No `pi-jev` dependency or extension is used.
4. The same decision call also selects a criterion to investigate (quick add,
   persistence, due dates, reminders or assignees), so a repair has a concrete focus.
   At most one Pi repair, followed by the same checks and a final decision.
   The entire job shares 40 observed Pi turns and 15 minutes; up to two decision
   POSTs have no retries. These are operational bounds, not a billing cap.
5. Only passing checks plus `ready_for_review` can export a patch. The controller
   reruns the four app checks, verifies the exported patch matches the QA-tested
   candidate hash, and kills the sandbox. Publication still requires its own command.

This first version uses direct Pi subprocesses and a controller-owned sequence,
not pi-subagents discovery or a new general workflow engine. A decision error or
unknown outcome stops the job. An unresolved final decision cannot publish.
Browser checks get a fresh session and credential-free environment. Raw page,
model and command output are not retained; bounded page title/accessibility observations and a product-spec excerpt are sent to the decision model as untrusted evidence, then discarded; only check statuses and the chosen action/focus are kept in the private job result. Temporary
screenshots are removed after the smoke check; they are not a visual judge input.

The independent browser smoke covers quick-add and persistence only. Due dates,
reminders, assignees, accessibility and broader UX still rely on the generated
app's tests and human draft-PR review. This is a working orchestration shape,
not proof of complete specification conformance or an independently calibrated judge. Only coding-model and Context7 credentials enter the remote
command; E2B and GitHub credentials stay local. Runtime credentials are readable
by the remote agent and its child processes, so use scoped, revocable credentials.

The app and its default tests require no model, MCP server, or cloud credentials.
Passing generated scripts is evidence, not an independent security attestation;
review the patch and test coverage. Status is a local read. To explicitly clean
up a known or reconciled sandbox:

```sh
pnpm recipe2 cancel --live
```

There is no background queue, durable resume, or whole-job retry. A crash or
unknown outcome can leave work/billing unresolved. Check the recorded sandbox
identity and your E2B account before authorizing another attempt. Never treat a
missing patch or timeout as proof that nothing ran or billed.

## 5. Publish the reviewed result separately

Once the exact patch and destination are approved:

```sh
pnpm recipe2 publish --live
```

The local publisher applies the patch in a fresh worktree without executing it,
checks paths/file modes and known sensitive values, then creates a branch and
**draft PR** using `GH_TOKEN`. It never merges or deploys. Unknown publication
outcomes require manual GitHub reconciliation, not blind replay.

## Qualification

Linux offline fixtures and current-toolchain checks pass. macOS, live E2B builds,
remote MCP/model execution and generated-app publication are not qualified.
Installation, skill loading, planning, and default tests create no sandbox and
make no model request. Build, run, cancel and publish require explicit live actions.

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

The default manifest allows results only under `examples/todo-app/`, a
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
