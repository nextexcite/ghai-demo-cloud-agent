# Versioned implementation references

Checked against the pinned source and installed packages on 2026-10-12:

- [Pi action v2.30.0 input contract](https://github.com/shaftoe/pi-coding-agent-action/blob/f7496a9aea9798c5d52d39096d98d5c5b16559b3/action.yml)
- [Action lockfile: Pi SDK 1.0.4](https://github.com/shaftoe/pi-coding-agent-action/blob/f7496a9aea9798c5d52d39096d98d5c5b16559b3/pnpm-lock.yaml)
- [Action provider/session initialization](https://github.com/shaftoe/pi-coding-agent-action/blob/f7496a9aea9798c5d52d39096d98d5c5b16559b3/packages/pi-orchestrator/src/pi/agent.ts)
- [Action finalization and comment behavior](https://github.com/shaftoe/pi-coding-agent-action/blob/f7496a9aea9798c5d52d39096d98d5c5b16559b3/packages/pi-orchestrator/src/orchestrator.ts)
- [Comment skip when no issue/PR target](https://github.com/shaftoe/pi-coding-agent-action/blob/f7496a9aea9798c5d52d39096d98d5c5b16559b3/packages/pi-platform-github/src/comments.ts)
- [Pi provider extension types, v1.0.4 source](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/extensions/types.ts)
- [Pi provider composition](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/provider-composer.ts)
- [Pi retry, compaction and cache settings](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/settings-manager.ts)

Discovery advertised the privately selected runtime models with the Responses
endpoint when inspected. That read-only check is not live inference evidence,
pricing verification, or qualification of other catalog capabilities.

This standalone implementation and documentation were written for the public
demo. No private application source, credentials, operating notes, or account
history are included. Referenced upstream packages retain their own licenses.

## Recipe 02 references

The installed Pi 1.1.0 and E2B 2.55.0 package documentation/types were inspected
on 2026-10-12. These references support the API/configuration choices; they do not
establish a successful live E2B build, model run, or publication.

- [Pi skills and explicit skill loading, versioned 1.1.0 source](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/skills.md)
- [Pi CLI resource flags, versioned 1.1.0 source](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md)
- [Pi native MCP configuration and retry semantics, versioned 1.1.0 source](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md)
- [Pi compatible endpoint configuration, versioned 1.1.0 source](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md)
- [E2B JavaScript SDK primary source](https://github.com/e2b-dev/e2b/tree/main/packages/js-sdk); the repository lockfile selects 2.55.0, not the moving `main` branch.
- [GitHub reference creation and required permissions](https://docs.github.com/en/rest/git/refs#create-a-reference)
- [GitHub draft pull-request creation and required permissions](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)
- [mise configuration and tool definitions](https://mise.jdx.dev/configuration.html)
- [Context7 MCP clients, including native Pi support](https://context7.com/docs/resources/all-clients)

- [TanStack Router React overview](https://tanstack.com/router/latest/docs/framework/react/overview)
- [Vite local development guide](https://vite.dev/guide/)
- [direnv dotenv loading](https://direnv.net/man/direnv-stdlib.1.html)

The TanStack references inform the local todo implementation brief. Compatible exact
application package versions and successful application checks are deliverables
for the future implementation job, not claims made by this recipe.

- [Immutable E2B template build selectors](https://docs.e2b.dev/template/tags):
  `template:build_id` selects a specific completed build rather than a mutable tag.
