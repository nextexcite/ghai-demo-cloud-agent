# GHAI cloud-agent recipes

A practical playground for combining **GHAI's AI capabilities** with flexible
agent runtimes, tools, and execution environments.

The larger idea is to make AI capabilities composable: choose the right model and
API for a task, give an agent a deliberately scoped tool set, run the work in an
appropriate environment, and keep its inputs, permissions, lifecycle, outputs,
and costs understandable. A code-review agent is the first small example of that
architecture. It is not the limit of this project.

## What this project is exploring

- **Generation:** text and code, structured outputs, images, audio, and video,
  using the protocol supported by each offering.
- **Understanding and retrieval:** transcription and other supported audio
  processing, embeddings, reranking, and retrieval pipelines.
- **Decisions:** classification, scoring, and other bounded decision workflows
  when a model exposes the appropriate API.
- **Agent orchestration:** different harnesses and SDKs, trusted skills,
  carefully selected tools, explicit handoffs, and observable execution.
- **Execution environments:** short CI jobs, an existing Pi installation on a
  Linux or macOS team workstation, and disposable E2B sandboxes with
  reproducible tool manifests.

These are the project's intended directions. A public catalog entry, configured
route, and working end-to-end recipe are different levels of evidence. This repo
does not claim that every model or capability has been validated.

## Where GHAI fits

GHAI is the capability gateway; an agent harness coordinates how a task uses it.
The gateway exposes OpenAI-compatible endpoint families where configured. That
**does not mean every offering uses the Responses API**, or that arbitrary
Chat/Responses/media protocol translation is available.

Connection details and model selections are private runtime configuration. Set
them as repository secrets before running a recipe; no public defaults are
provided. Query discovery through that configured endpoint when selecting an
operation. Match advertised endpoint support, modalities, and input requirements
to the client. Discovery metadata is not proof of account eligibility,
availability, pricing, or quality.

A recipe should describe its task, selected capability, provider/API binding,
agent runtime, available tools, trust boundaries, execution environment,
acceptance checks, request allowance, and resulting artifacts. The same pattern
can grow from a single bounded model call to deliberate multi-step orchestration.

## Recipes and current status

| Recipe                                                             | Purpose                                                                                | Status                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 01 · Bounded Pi PR review                                          | Read-only diff review through GHAI Responses in a manual GitHub Actions job            | Implemented; deterministic offline transport and installed-Pi fixtures    |
| [02 · Delegated development](recipes/02-e2b-development/README.md) | A trusted Pi skill plus a small CLI for spec-first work in disposable E2B environments | Implemented; offline fixtures only; no live template build or sandbox run |
| Further capability recipes                                         | Generation, media, decision, retrieval, and mixed workflows                            | Exploration; not implemented or qualified here                            |

No live model call is performed by installation, local checks, a push, or a pull
request. There are no automatic push/PR workflows or automatic image builds.
Recipe 02 template builds and sandbox execution require explicit live commands.
The only GitHub workflow is manually dispatched and defaults to inference disabled.

## Recipe 01: bounded Pi review

The first recipe demonstrates a small, auditable lifecycle:

1. A maintainer starts the workflow on `main`, explicitly allowing inference.
2. Trusted code fetches an open PR's base/head SHA and the diff between those
   immutable revisions, or selects a small synthetic fixture.
3. Pi loads one trusted extension. It registers provider `ghai` with the explicit
   `openai-responses` API and disables all tools.
4. A custom transport reserves one primary request before dispatch. It sends
   directly to the privately configured Responses endpoint, without SDK transport retries.
5. Only an allowlisted pre-execution model rejection can permit one separately
   accounted fallback. Interruptions and unknown-billing outcomes stop.
6. A completed SSE terminal event, consistent text, usage bounds, and schema-validated findings are required before any review text is emitted.
7. The job uploads a sanitized review and accounting artifacts. It does not post
   comments, modify files, or execute PR code.

### Setup

Requirements: Node 24, pnpm, and optionally [mise](https://mise.jdx.dev/). The
repository pins exact tool versions in `mise.toml` and dependencies in the
lockfile. Package lifecycle scripts are disabled during setup.

```sh
mise run setup
mise run check
# Or, using the pinned Node/pnpm versions already installed:
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

The checks are credential-free and use in-memory Responses fixtures, including
actual Pi processes for both the action-bundled SDK and the current standalone
SDK. They do not qualify a live provider or prove a new schema works on a
GitHub-hosted runner. The action stays pinned to its audited release; the
standalone toolchain is tracked separately.

Add these GitHub Actions repository secrets yourself:

| Name                     | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `GHAI_API_KEY`           | Run-only credential used only in inference steps |
| `GHAI_PI_BASE_URL`       | Private HTTPS endpoint ending in `/v1`           |
| `GHAI_PI_PRIMARY_MODEL`  | Private primary model selection                  |
| `GHAI_PI_FALLBACK_MODEL` | Private, distinct fallback model selection       |

All four are required. There are no endpoint or model defaults. Use secrets for
these values in a public repository so the runner masks them in logs. Do not put
connection details or credentials in public files. The base must be HTTPS, with
no embedded credential, query string, or fragment. Runtime configuration is
frozen privately for each run. Public accounting uses only `primary` and
`fallback` labels.

### Run manually

Open **Actions → Bounded Pi review → Run workflow**, select `main`, and enter:

- `pr_number`: an open PR number in this repository, or `verify`
- `allow_inference`: explicitly enable only when you authorize the displayed
  request allowance

**`verify` is a live synthetic inference run when opted in.** It is not the
credential-free local test suite. This repository has not automatically run it.
Rerunning an existing workflow attempt is blocked. A new dispatch represents a
new explicit allowance; inspect previous unknown outcomes before authorizing it.

### Bounds and limits

- At most one primary POST plus one eligible fallback POST per workflow run.
- At most 32,768 UTF-8 diff bytes and 49,152 serialized request bytes. Oversize
  input is rejected, never silently truncated.
- Each request sets `max_output_tokens: 2048`. Reported completed usage above
  that limit is rejected. There are no tool turns, compaction calls, cache-warming
  calls, model refresh calls, redirects, or automatic transport retries.
- Each transport has a 90-second timeout and a 262,144-byte response limit.
- All reservations, including rejected and unknown outcomes, consume allowance.
- These are client-side request and acceptance bounds, **not a monetary cap**.
  They do not prove or constrain a remote service's internal behavior. Actual
  billing stays unknown; SDK zero-cost fields are display placeholders only.

The controls constrain this trusted recipe. They are not an OS/network sandbox,
an account-budget control, or a defense against a maintainer replacing trusted
workflow code. See [the security contract](docs/security.md).

### Results

The workflow summary shows one actual review: target/revisions, overall verdict,
and findings with severity, file/line, explanation, and proposed fix. A synthetic
run is prominently labeled as a deliberately faulty qualification sample, not a
review of a real PR. Every finding must refer to a file and new-side line actually
present in the prepared diff. Fixture tests never write the live summary.

The `pi-review-<run_id>` artifact retains five files for seven days:

- `plan.json`: protocol, request-slot labels, limits, and billing caveat
- `provenance.json`: workflow SHA, PR base/head or fixture hash, diff hash/size
- `attempts.jsonl`: durable reservations and sanitized state transitions
- `report.json`: verified completion or stopped state, usage, billing unknown
- `review.md`: structured findings rendered with escaped untrusted text

Prompts, diffs, concrete connection/model configuration, raw provider errors,
credentials, Pi config, and session exports
are excluded from the artifact upload. Reviews may still describe source code;
artifact sanitization is not a general-purpose confidential-code redactor.

## Extending the playground

Prefer a new recipe with a clear acceptance test over silently expanding the
first recipe's permissions. In particular, a coding agent that edits files or
runs commands needs a different tool, credential, and isolation contract from a
read-only reviewer. Media jobs and asynchronous jobs also need their own
completion, cancellation, storage, and polling rules.

See [architecture and roadmap](docs/architecture.md),
[security and failure behavior](docs/security.md), and
[pinned source references](docs/sources.md).
