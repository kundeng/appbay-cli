# Review ledger

The durable record of the review track described in `CLAUDE.md`. Chat is where a note is
discussed; this file is where its outcome lands. One row per finding, appended in the turn
it is raised, updated in the turn its status changes. The position line at the top is what
the next session resumes from.

**Position (2026-09-05):** 1 file read · open: 10 · next: `packages/core/src/services/deploy-service.ts`, Kun's annotations.

## Protocol

- A finding gets a row when it is first stated, whether by Kun or by Claude, with the
  file and line it was read from and the shape it matches (1 reported-unobserved success,
  2 same behaviour twice, 3 test that runs nothing, S structural).
- `verified` means the claim was read from the named lines or produced by a command that
  is quoted. `reasoned` means it follows from reading but was not run. A reasoned row that
  matters gets run before it becomes `confirmed`.
- Status moves `open` → `confirmed` or `rejected` → `fix proposed` → `committed <sha>`.
  A fix is proposed only after Kun calls the row a defect, and lands only after Kun says so.
- No code changes while the review is on a file, beyond the one-file diff for a confirmed row.

## Findings

| # | file:line | shape | claim | evidence | status |
|---|---|---|---|---|---|
| 1 | `packages/core/src/services/deploy-service.ts:820-830` | 1 | `deploy()` treats a `null` from `findCrashedServices()` as "nothing crashed"; the contract at line 197 says `null` means "could not inspect". | verified, read | open |
| 2 | `deploy-service.ts:105` | 1 | `composePs()` retries without `-a` on any non-zero exit. On Docker, `-a` is what lists stopped containers (`docker compose ps --help`, v5.1.2), so a transient failure of the first form makes the crash detector vacuous on Docker too. | verified, help text run locally | open |
| 3 | `deploy-service.ts:817-850` vs `930-975` | 2 | The converge block (up, crash check, Caddy install, count) exists twice. Only the second snapshots before and after; the first reports `deployed` without observing a container. | verified, read | open |
| 4 | `deploy-service.ts:205` | 1 | Crash test is `state === "exited" && exitCode !== 0`. A `restart: always` service in a crash loop reports `restarting` and is counted as running. | reasoned | open |
| 5 | `deploy-service.ts:819` | 1 | The crash check runs once, immediately after `up -d` returns. A container that fails a few seconds in is reported deployed. | reasoned | open |
| 6 | `apps/cli/src/commands/ps.ts:64-110` | 2 | A second parser of `compose ps --format json`. No banner skip and reads `Name`, not `Names[]`, so `appbay ps` lists nothing on a Podman host. The fix in d56474f reached `deploy-service.ts` only. | reasoned from both sources; no Podman host here | open, raised by Kun's note on placement |
| 7 | `deploy-service.ts:100-270` | S | The container-state readers (`composePs`, `parseComposePsJson`, `findCrashedServices`, `snapshotContainers`) have no deploy input and belong in `packages/core/src/runtime/`, which already claims `ps --format` at `container-runtime.ts:186`. `didConverge` can go either way. | verified, read | confirmed, Kun's note |
| 8 | repo-wide | S | State is observed by parsing CLI output. The Engine API on the socket the CLI already resolves (`apps/cli/src/commands/server.ts:70-79`) returns typed `State`/`Status`; verified locally with `curl --unix-socket /var/run/docker.sock 'http://localhost/containers/json?all=1'`. Mutation stays with `compose up -d`, observation should move to the socket. The Go rewrite already draws that line (`stackbay/docs/design/lessons-paid-for.md:222-229`). Podman's compat API claim is from memory. | verified for Docker, reasoned for Podman | confirmed, Kun's note |
| 9 | `deploy-service.ts:616`, `apps/cli/src/commands/up.ts:25-31` | S | RFC-001 §4 says a namespace absent from the manifest is "decided at deploy time". `compile()` accepts one (`compile.ts:104`, resolved at `:422`) but `deploy()` never passes it and no command has a `--namespace` flag, so a namespace is a manifest field only. The compose project name is the app directory (measured: `docker compose config` on `renders/whoami/` → `whoami`); the namespace never reaches it, by design via `install --as`. `instance.ts:92` calling `project` "the compose project prefix" is stale. | verified, read and run | open |
| 10 | `packages/core/src/compiler/scope-resolver.ts:50`, `compile.ts:462-466` | S | The goal RFC-001 §4 was opened for (F49: two instances of one app in one home) is met for identity and not for values. `VALID_SCOPES` is still `service, environment, project`; `environment` is still fed `{}` per run; no `app` scope exists, so `host: litellm.${{project.DOMAIN}}` in two `install --as` copies renders the same vhost. F49's second fix (`${{app.NAME}}`) was never tasked; RFC 4.6 (per-namespace values) was decided against in S32. The namespace never touches the hostname. | verified, read | open: design decision for a successor spec |
