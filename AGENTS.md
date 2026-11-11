# pi-claude-auth — map for changing the code

pi extension that reads Claude Code OAuth credentials. Requires pi 0.85+.

## Invariants

- **Claude Code is the only credential writer.** Delegate refresh to `claude`;
  pi receives access/expiry and an empty refresh token, never the real one.
- **Every consuming pi process must load this extension**, including children.
  Otherwise pi's built-in refresh attempts the empty token and fails with 400.
- **Claude Code's own refresh lock guarantees a single rotator.** It
  serializes concurrent refreshes across processes and re-reads the token
  under the lock. This extension keeps no cross-process lock or record; it
  only joins concurrent requests to one CLI run per process and remembers, in
  memory, a credential state a completed run did not refresh.
- **`refreshToken` returns at once while the token is still usable.** pi calls
  it holding its `auth.json` lock (other pi processes give up after 30s), so it
  starts the CLI run without waiting for it. Only an expired token waits, and
  only until pi's signal; the signal never stops the run, only its own
  timeout (SIGTERM, then SIGKILL) does.
- **pi's `auth.json` keeps pi's locking protocol.** Only a missing file may
  initialize an empty object. Reject invalid/non-object contents without changing
  them; preserve unrelated providers and replace valid contents atomically.
- **pi owns model catalogs and tool-schema conversion.** This extension owns
  credential bridging and Claude Code billing headers.

## Source map

| File | Contains |
|------|----------|
| `src/index.ts` | Provider registration, OAuth hooks, session notification |
| `src/credentials.ts` | Account selection and credential-store effects |
| `src/credential-store.ts` | Re-read, single-flight CLI run, in-memory retry suppression, caller waits; injected effects |
| `src/keychain.ts` | Claude credentials from macOS Keychain or file |
| `src/claude-cli.ts` | Delegated CLI run, its timeout and kill policy; version detection |
| `src/dir-lock.ts` | pi-compatible directory lock for `auth.json` |
| `src/auth-json.ts` | Seed/remove pi credentials, parsing boundary, atomic writes |
| `src/paths.ts` | Credential and pi-profile paths |
| `src/signing.ts`, `src/transforms.ts` | Claude Code identity and billing header |
| `src/logger.ts` | Opt-in redacted diagnostics (`PI_CLAUDE_AUTH_DEBUG`) |

## Verification and release

`main` is the release channel (`@main`, no version tags). Keep it green.
See `README.md` for limitations.

Analyze callers and affected flows before edits; review the diff before commits.
`just all` (lint, build, test) must pass before every commit. `just smoke` must
pass before pushing to `main`. Unit tests use Node; pi embeds Bun with a proxied
`node:fs`. Mutating that module object (as `proper-lockfile` does) crashes pi;
unit tests alone do not cover that runtime.

Unit tests use temporary `HOME` and `PI_CODING_AGENT_DIR` and fake CLIs.
Keep all unit-test credentials and CLI executions isolated from real accounts.

`scripts/smoke-pi-runtime.ts` first runs fully isolated with fake expired
credentials and a stub CLI. Its second run reads real credentials and seeds real
pi `auth.json` and makes a model request. It skips tokens within five minutes of
expiry and guards the CLI with a failing stub so it cannot redeem a real refresh
token. No live model-probing script is maintained.
