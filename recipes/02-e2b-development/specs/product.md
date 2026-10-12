# Product spec: local todo app

Status: implementation brief only; the app is intentionally not prebuilt here.
Freeze this document and technical.md before cloud delegation.

## Outcome

Build `examples/todo-app`, a small classic todo demo that runs locally with a
TanStack React frontend. The cloud coding agent implements this brief later;
the app itself needs no agent, model, cloud service, account, or API credentials.

## Simple everyday flow

- One page with a quick-add title field and Add button; Enter also adds the task.
- Show optional Due and Reminder date/time inputs and an Assignee select beside
  quick add, wrapping naturally on small screens. Title is the only required
  user input; use the configured default assignee and leave dates empty.
- List tasks with a completion checkbox, title, assignee, due/reminder details,
  and small Edit/Delete controls. Edit these same fields inline, with Save and
  Cancel; cancel leaves the task unchanged.
- Support complete/reopen and All/Active/Completed filters with a remaining count.
  Confirm deletion inline so a stray click cannot remove a task.
- Treat expiry as the due date/time: mark unfinished past-due tasks Overdue,
  never automatically delete them. Display dates in the browser's local timezone.
- Show a dismissible in-app reminder when an unfinished task's reminder time is
  reached. Catch up on missed reminders when the app is reopened. State plainly:
  reminders appear in this app; closed/background tabs cannot reliably notify.
- Save tasks on this browser/device across refresh. Provide a helpful empty state,
  readable validation/storage errors, visible focus, and keyboard-friendly labels.

## Assignee parameters

Allow an optional comma-separated `assignees` URL parameter and optional
`defaultAssignee`, for example `/?assignees=Alex,Sam&defaultAssignee=Sam`.
Use `Me` when no valid list is supplied; use the first allowed name when the
requested default is missing or invalid. These are local display names, not
accounts or a team system. Changes to configuration never silently reassign
existing tasks. Document parameter validation and examples in the app README.

## Acceptance and delivery

1. Add with only a title, then edit due date, reminder, and assignee; complete,
   reopen, filter, cancel an edit/delete, and confirm a deletion.
2. Refresh preserves data. Configured assignees/defaults work; malformed parameters
   safely fall back. Invalid fields leave the current task unchanged.
3. An unfinished past-due task is visibly overdue. A due reminder appears once per
   scheduled time, including catch-up after reopening; completed/deleted tasks
   do not trigger reminders. Test with a controlled clock, without waiting.
4. The responsive page is usable with keyboard alone and renders input as text.
   Storage problems show a warning rather than pretending data was saved.
5. Deliver a locked package under `examples/todo-app/` with passing `lint`,
   `typecheck`, `test`, and `build`; document local startup, parameters, storage,
   reminder limits, and any unverified behavior.

Keep this a single-user, local-browser demo. No chat, conversational UI,
Cloudflare/Workers/Agents SDK, server/backend, authentication, team management,
cross-device or collaborative sync, email/push notifications, deployment,
automatic workflow changes, or merges are in scope.
