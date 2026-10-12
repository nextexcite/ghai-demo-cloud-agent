# Technical spec: local todo app

Status: implementation brief; freeze alongside product.md before delegation.

## Stack and boundary

Use TypeScript, React, Vite, and `@tanstack/react-router`. A single `/` route with
validated search parameters is enough. Keep state in React and localStorage;
no backend, TanStack Start server, Query layer, external app API, or credentials
are needed. Do not add Cloudflare, Workers, Agents, chat, or model dependencies.
The coding agent's infrastructure is separate from this app's runtime.

Resolve compatible exact dependency versions during implementation, commit the
app lockfile, and record tested versions in its README. Check current primary
TanStack documentation through Context7 before implementing routing/search APIs.
Provide `dev` and `preview` scripts in addition to the required checks; bind local
servers to loopback by default. Keep all implementation in `examples/todo-app/`.

## Data and validation

Todo fields: `id`, `title`, `completed`, `assignee`, `dueAt`, `reminderAt`,
`reminderShownFor`, `createdAt`, `updatedAt`. Generate IDs with `crypto.randomUUID()`.
Store timestamps as ISO instants; nullable date/reminder fields use `null`.
`reminderShownFor` stores the reminder instant already displayed, or `null`.

- Trim titles; require 1–200 characters and cap the demo at 200 tasks.
- Use native `datetime-local` inputs, converting local values to/from instants.
  Reject invalid dates. Past due dates are valid; a newly set/changed reminder
  must be in the future and no later than due time when a due time exists.
  Unchanged past reminders remain valid when loading or editing another field.
- Validate every mutation before changing state. Unknown IDs are harmless errors;
  duplicate titles are fine because controls operate on IDs. Render all strings
  as inert text, never injected HTML.
- Parse `assignees` as a comma-separated string: trim names, omit empty entries,
  deduplicate exact names in order, require 1–20 names of 1–40 characters
  without control characters. Non-string or out-of-bounds lists fall back to
  `['Me']`. Trim `defaultAssignee`; accept only an exact member of the effective
  list, otherwise select its first name. Ignore unrelated parameters. Use
  TanStack Router search validation without crashing on malformed input.
- Existing saved assignees remain visible when the URL list changes; only new
  assignments must use its allowed names. Parameter changes do not rewrite tasks.

## Local persistence and reminders

Use one versioned localStorage key with a schema-validated payload. Load before
the first write; validate stored records, unique IDs, bounds, and timestamps.
Handle malformed/unsupported saved data or unavailable/full storage with a
visible not-saved warning and in-memory operation. Do not silently overwrite
unreadable saved data. Document how the user can clear this app's local storage.
Multi-tab concurrent editing and synchronization are outside this demo's scope.

With an injectable clock, check reminders on load, on returning to a visible
tab, and periodically while visible. For each unfinished task with a non-null
`reminderAt <= now` whose `reminderShownFor` differs, show a dismissible in-app
notice and persist that scheduled instant as displayed. Changing/clearing a
reminder resets the marker. Completing/deleting cancels a pending notice;
reopening does not repeat one already shown. Catch up on overdue, unseen
reminders after reopening. Calculate overdue status from the same clock.
Clean up timers/listeners on unmount. No service worker, OS notification
permission, background scheduler, email, or push delivery; hidden/closed tabs
cannot guarantee timely delivery. Storage failures also prevent reliable
deduplication across reloads, which the warning/README must explain.

## Verification and documentation

- Unit tests: validation, mutations, bounds, dates, assignee normalization and
  fallbacks, persistence corruption/failure, and reminders with a fake clock.
- UI/integration tests: quick add, inline edit/cancel/delete, filters, refresh
  persistence, custom URL parameters, overdue/reminder catch-up, completed/deleted
  reminder suppression, and keyboard interaction.
- Expose and run `lint`, `typecheck`, `test`, and `build`. Checks must be
  credential-free and make no external service or model requests.
- README: setup/run/check commands, local URL and parameter examples, timezone
  behavior, single-device storage limitations, and honest reminder guarantees.
  Report passed, failed, and unrun checks separately; do not claim deployment.

## Primary references

- [TanStack Router React quickstart](https://tanstack.com/router/latest/docs/framework/react/quick-start)
- [TanStack Router search parameters](https://tanstack.com/router/latest/docs/guide/search-params)
