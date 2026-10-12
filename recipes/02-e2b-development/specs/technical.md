# Technical spec: conversational todo agent

Status: ready implementation brief; freeze alongside product.md before delegation.

## Architecture

Use TypeScript, React, the Cloudflare Vite/Workers development path, `agents`,
`@cloudflare/ai-chat`, the AI SDK, and Zod. Resolve mutually compatible exact
versions, commit a lockfile, and record the tested versions in the app README.
Use Context7 to verify APIs before implementation.

`TodoAgent` extends `AIChatAgent` imported from `@cloudflare/ai-chat`.
Use `useAgentChat` from `@cloudflare/ai-chat/react` and `useAgent` from
`agents/react`. Do not use obsolete `agents/ai-chat` imports.

## State and mutations

Todo: `{ id, title, completed, createdAt, updatedAt }`. IDs and timestamps are
server-assigned. Bound titles to 200 characters and the demo to 200 todos.
Use a small synchronized state collection; let the chat package persist history.

Share one validated server mutation layer between chat tools and UI RPC methods.
Validate with Zod. Deduplicate by operation/tool-call ID using bounded persisted
operation results. Resolve todo IDs on the server; ambiguous titles require user
clarification. Deletion must follow explicit tool approval.

Reject wholesale client state replacement in `validateStateChange`; do not use
`onStateChanged` as a pre-persistence validator. Mutations must preserve invariants
before persistence/broadcast. Render chat/todo strings as inert text.

## Model and credentials

Configure a server-only GHAI Responses adapter through `GHAI_PI_BASE_URL` and
`GHAI_PI_PRIMARY_MODEL`. Never hardcode actual gateway hosts, base URLs, or model
IDs in generated tracked files. Preserve verified compatible request behavior;
check actual SDK interfaces rather than assuming every OpenAI option is supported.
A deterministic fake model is the default for tests and demo verification.
No credentials belong in browser bundles or tracked files. App runtime secrets
are configured separately from the coding agent's runtime secret.

## Verification and bounds

- Unit tests: validation, mutation rules, ambiguous/unknown IDs, approval denial,
  operation replay, state bounds, and errors.
- Workers integration tests: persistence and invalid client-state rejection.
- Browser tests: conversational flow, refresh, two-tab sync, reconnect, errors,
  and keyboard interaction, using a fake model.
- Document and expose `lint`, `typecheck`, `test`, and `build` package scripts.
- Keep network calls off in the default tests. Do not deploy or request Cloudflare
  credentials to prove local correctness.

## References

- https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/
- https://developers.cloudflare.com/agents/runtime/lifecycle/state/
- https://developers.cloudflare.com/agents/getting-started/testing/

This is a development demo with a shared room, not a production multi-user app.
