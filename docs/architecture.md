# Architecture and roadmap

## Capability gateway + orchestration + execution

The repository showcases how GHAI can be used from multiple agent contexts.
Keeping three responsibilities separate makes recipes easier to compare:

1. **Capability gateway:** protocol-aware discovery, selected model/operation,
   authentication, transport, and provider responses.
2. **Orchestration:** task intent, specification, runtime/harness/SDK, trusted
   skills, tool access, handoffs, acceptance checks, and lifecycle ownership.
3. **Execution:** a CI runner, a Linux/macOS workstation, or a disposable sandbox;
   pinned dependencies, filesystem boundaries, network exposure, and cleanup.

A fourth cross-cutting concern is evidence: provenance, budgets, observed versus
unknown outcomes, artifact handling, and a clear stopping condition.

The public catalog can describe generation, audio/media, decision, embeddings,
reranking, and related capabilities with different endpoint families. Recipes
must explicitly select and validate the applicable protocol. The `ghai` provider
and `openai-responses` binding in recipe 01 are one specific pairing.

## Recipe 01 implementation

- `ops/ci/policy.mjs`: required private runtime configuration and immutable limits
- `ops/ci/review.mjs`: manual-run guards, immutable diff capture, fresh config,
  fail-closed decisions, and artifact generation
- `ops/ci/review-format.mjs`: strict structured findings, diff-line validation,
  and escaped human-readable review output
- `ops/ci/http-once.mjs`: a single native HTTPS request without Fetch replay
- `ops/ci/transport.mjs`: one Node HTTPS request per invocation; no SDK retry transport;
  durable reservation; strict bounded SSE parsing; explicit safe fallback
- `ops/ci/pi-review-extension.ts`: public-slot provider registration, empty
  tools, disabled sentinel, and buffered terminal-only output; tested against
  the action-bundled SDK 1.0.4 and standalone SDK 1.1.0
- `ops/check-policy.mjs`: executable checks of workflow permissions, pins,
  dispatch-only trigger, isolation, tool disablement, and artifact allowlist
- `tests/`: deterministic success/failure/mutation fixtures and installed-Pi
  child-process tests with a mocked native HTTPS transport

The custom provider binds `ghai` to `openai-responses`. There is no unbounded
built-in transport call behind that binding. The action fails if the trusted
extension cannot register the explicitly named disabled-tool sentinel; the
fresh agent directory contains no fallback provider or credential catalog.

## Recipe 02 implementation: delegated development

[Recipe 02](../recipes/02-e2b-development/README.md) uses a trusted skill and a
small deterministic CLI. An existing local Pi session on Linux or macOS supervises
the work; no custom extension or global Pi configuration change is required.
The remote Pi 1.1.0 process uses native MCP support for Context7 only.

The handoff freezes a product specification, a technical specification, the
selected existing GHAI model definition, exact repository/base SHA, environment
manifest, allowed result scope, and execution limit. The included todo-app specs
describe a classic local TanStack todo app with browser persistence, due/reminder
times and configurable assignees. The application has not been prebuilt.

The local controller owns the lifecycle:

1. `doctor` and `plan` perform local checks and prepare the handoff.
2. An explicitly authorized live template build prepares a pinned Linux x64
   environment from the sandbox-only mise manifest and lockfile.
3. `run --live` creates the sandbox, supplies selected runtime credentials, starts
   remote Pi, and collects the patch, result evidence, and cleanup state.
4. `status` reads local job evidence; `cancel` requests cleanup. There is no
   background queue or durable resume/retry service.
5. A separately authorized `publish --live` publishes a branch and draft PR using
   the local GitHub credential. Neither execution nor publication merges or deploys.

E2B and GitHub publication credentials stay with the local controller. Remote Pi
receives GHAI and the selected MCP credentials only. Command-scoped environment
variables are not private from the sandbox agent or its child processes. The
workstation's Pi home, authentication state, extensions, personal instructions,
and unrelated MCP configuration are not copied into the sandbox.

Unlike the read-only review, a coding agent has shell and file tools, can make
multiple model/tool calls, and can run repository code. An accepted-output path
check is not an OS sandbox policy. Time limits are not monetary caps, and a
controller timeout or unknown result does not prove absence of work or billing.
Raw service output is excluded from derived, sanitized job records, but outputs
still require review before sharing.

The CLI and fake-E2B paths are exercised by credential-free offline tests on Linux.
The live E2B template build, sandbox execution, GHAI/MCP behavior, GitHub
publication, and macOS controller have not been live-qualified. The repository
adds no automatic workflow and provisions nothing during installation or tests.

## Future recipes

Choose capabilities by task: structured generation, audio workflows, image/video
jobs, classifier decisions, embeddings and rerank-backed retrieval, or carefully
bounded combinations. Each recipe needs protocol-specific completion evidence,
inputs/outputs, errors, cost visibility, and acceptance tests. An advertised
capability is a candidate, not a claim of end-to-end support in this repository.
