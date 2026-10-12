# Product spec: conversational todo agent

Status: ready implementation brief; the app is intentionally not prebuilt here.
This document and technical.md must be frozen before cloud delegation.

## Outcome

Build `examples/todo-agent`, a local-development web app demonstrating the
Cloudflare Agents SDK. A user manages a visible todo list through chat or simple
controls. Implementation returns as a branch and draft PR; deployment is excluded.

## Scope

- Add, list, rename, complete, reopen, and delete todos through conversation.
- Provide direct add and complete/reopen controls and a chat composer.
- Ask for clarification when a title matches multiple todos.
- Show an explicit approve/deny step before deletion.
- Persist chat and todos across refresh; synchronize two tabs in the same demo room.
- Show empty, connecting, streaming, error, and retry states. Support keyboard use.
- Use a shared local demo room, labeled as such. No authentication, public hosting,
  scheduled reminders, dates, attachments, or external integrations in this version.

## Acceptance criteria

1. A scripted conversation adds two items, renames one, completes and reopens an
   item, and deletes only after approval.
2. Refresh preserves chat and todos. Two tabs show the same completed mutation.
3. Replaying an operation ID or reconnecting cannot duplicate a mutation.
4. Invalid input, unknown IDs, ambiguity, denied deletion, and model errors do not
   corrupt state or falsely claim success.
5. The page is responsive, accessible by keyboard, and renders untrusted text safely.
6. Credential-free unit/integration/browser tests cover the above. Real model
   requests require a separately enabled smoke test.
7. README explains local development, fake-model mode, checks, secret variable
   names, and the shared-demo/no-auth limitation.

## Delivery

A small implementation under `examples/todo-agent/`, its own locked dependencies,
passing lint/typecheck/tests/build, and concise documentation. No Cloudflare deploy,
no automatic workflow edits, no merges. Report checks not run and blockers honestly.
