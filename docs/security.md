# Security and failure contract

## Trust boundary

Only a manually dispatched `main` workflow, on its first attempt and with
`allow_inference: true`, reaches model execution. All actions are full-SHA pinned.
Checkout uses the triggering trusted commit with persisted credentials disabled.
The workflow never checks out, imports, installs, or runs PR-head code. PR titles,
bodies, comments, and instructions do not become workflow instructions. The diff
is JSON-encoded untrusted data from a comparison of immutable base/head SHAs.

The GitHub token has only `contents: read` and `pull-requests: read`. No action
`pr_number` is supplied; the Pi action therefore has no issue/PR comment target.
That action's built-in comment behavior is separate from its tools, so disabling
tools alone would not suffice. The workflow-level input with the same name is
used only by our preparation script.

Each run creates a mode-0700 directory, mode-0600 files, fresh HOME, fresh
PI_CODING_AGENT_DIR, empty auth, disabled retry/compaction/cache warming, and no
installed packages. HOME is scoped to individual action steps; developer/user
HOME and XDG directories are not changed. The trusted checkout contains no .pi
project configuration. Adding one is blocked by the local policy check.

The Pi action sees only the trusted main checkout and trusted extension. This is
not an OS sandbox: trusted maintainers can change workflow code or dependencies.
The sentinel/tool hooks, immutable prepared payload, and custom transport block
ordinary agent tools and additional model turns. Review text is untrusted too.

## Accounting state machine

Before the only outbound inference POST, a reservation is appended and fsynced.
A per-model create-only lock prevents repeated invocations across processes. A
closure guard prevents concurrent/repeated calls in one process. The result is
initialized as `unknown` before network dispatch.

- **completed:** received a complete, bounded SSE response containing exactly
  one successful `response.completed`, final output matching streamed text,
  permitted output types, coherent usage within limits, and schema-valid findings tied to actual diff lines.
- **rejected-before-execution:** HTTP 400/404/422 plus an exact error code from
  `model_not_found`, `model_not_supported`, or `unsupported_model`. Only this
  primary state permits a separately reserved fallback. This classification
  depends on the gateway honoring ordinary rejection semantics; actual billing
  remains unknown even for rejected calls.
- **http-failure-billing-unknown:** other status/error combinations, including
  authentication errors, rate limiting, and server errors. Stop.
- **unknown:** network interruption, timeout, malformed/truncated SSE, wrong
  content type, incomplete/failed terminal status, missing or invalid usage,
  tool output, invalid structured findings, or output limit violation. Stop.
- **policy-stop:** replay, request mutation, tool use, compaction, or another
  local policy failure. Terminal for the run.

No unknown outcome is automatically retried or routed to fallback. No timeout,
error, local process exit, or absence of a review is evidence that no provider
work or billing occurred. A killed process can leave only its reservation; that
also stops. A new workflow dispatch is a new allowance, not a continuation.

## Limit claims

The transport executes at most one Node HTTPS request per permitted model and never
follows redirects. It deliberately avoids Fetch, whose HTTP 421 behavior can
redispatch a replayable POST even with redirect handling disabled. It does not call a provider SDK transport that might retry.
Any Pi retry or subsequent turn encounters the spent invocation guard. The
request payload is reconstructed from trusted prepared data, contains no tools,
and is compared to its immutable serialized form before dispatch. Private wire
payloads and response headers are never passed to Pi's logging hooks.

`max_output_tokens` constrains the request according to the remote Responses
contract, and reported completed output usage is checked. The client cannot
stop the remote service from disregarding parameters or prove what occurred
behind a gateway. It cannot place a hard currency ceiling on an account. Pricing
is not encoded: required Pi cost fields are zero-valued UI placeholders;
`actualBillingUsd` in the report is always null.

## Artifacts and logs

Only the allowlisted five files are uploaded. Known delivered credentials,
bearer strings, common credential patterns, and control characters are redacted
from decoded review string fields. Configured identities are matched case-insensitively,
then the sanitized result is revalidated. Pi registers only public slot aliases
and a non-routable display URL plus a noncredential key placeholder. These are SDK
display metadata, never runtime connection defaults. Private IDs, credentials, and
the real endpoint are resolved only by the custom transport. Raw errors and upstream topology are not stored. Review
Markdown entity-escapes untrusted content to avoid activating HTML, links, or images.
The job summary is written only by the final live command, never by fixture tests. It shows one structured review with target revisions and escaped findings. Transport details are secondary.

A model may repeat source details. This filtering does not guarantee detection
of every secret or confidential passage in input code. Review access to GitHub
Actions logs/artifacts before applying this recipe to a private repository. The
Pi action can log the sanitized final text. Session exports and sharing are off;
ephemeral local session files are not uploaded.

Pinned dependencies still have supply-chain risk. Inspect pin updates and rerun
all offline tests before approving a new runtime. A pin is reproducibility, not
an independent security endorsement.

## Supported review input

Only bounded text unified diffs with unambiguous new-side paths and hunks are
accepted. Binary, combined, submodule, quoted-path, and metadata-only changes
fail during preparation before inference. Every reported finding must name an
actually displayed new-side line. This deliberately narrow recipe never fills
in missing context or pretends an unsupported diff was reviewed.
