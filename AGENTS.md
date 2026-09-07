# pi-claude-auth — map for changing the code

pi extension that authenticates pi as Claude Code by reading Claude Code's own
OAuth credentials. Requires pi 0.85+.

**Governing rule: Claude Code is the only writer of its credentials.** Claude's
refresh tokens are single-use, so a second rotator gets the session revoked and
logs the user out. pi reads the credentials, delegates every refresh to the
`claude` CLI, and never stores the real refresh token in pi's `auth.json`.

| File | Contains |
|------|----------|
| `src/index.ts` | The extension: provider registration, OAuth hooks, session notification |
| `src/credentials.ts` | Account list, active account, and the wiring of the credential store to real files/CLI |
| `src/credential-store.ts` | The policy: when to re-read, when to delegate a refresh, when to give up. All effects injected, so it is testable without `claude` |
| `src/keychain.ts` | Reading and parsing Claude Code credentials (macOS Keychain, credentials file) |
| `src/claude-cli.ts` | Running `claude` to make it refresh its own credentials |
| `src/dir-lock.ts` | Cross-process mutex (`mkdir` of `<target>.lock`, pi's own on-disk protocol) |
| `src/refresh-lock.ts` | The machine-wide lock that serializes the delegated refresh |
| `src/futile-refresh.ts` | Shared record of a refresh that changed nothing, so no process asks the CLI twice about the same credential state |
| `src/auth-json.ts` | Writing and removing pi's `auth.json` entry (empty refresh token, pi's lock protocol) |
| `src/paths.ts` | Every path the extension touches |
| `src/signing.ts`, `src/transforms.ts` | Claude Code user-agent and billing header |
| `src/logger.ts` | Opt-in redacted diagnostics (`PI_CLAUDE_AUTH_DEBUG`) |

`just all` (lint, build, test) must pass before every commit. Unit tests run
under `node`, but the extension runs inside pi's embedded **Bun**, whose
`node:fs` is a Proxy — code that mutates the fs module object (as
`proper-lockfile` does) passes the unit tests and crashes pi. `just smoke`
exercises the extension in the real pi runtime and must pass before a release.

Tests must never touch the real `~/.claude` credentials or `~/.pi/agent`:
they override `HOME` and `PI_CODING_AGENT_DIR` to a temp dir, and never run a
real `claude` refresh (redeeming the refresh token would log the user out).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pi-claude-auth** (362 symbols, 645 relationships, 23 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pi-claude-auth/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pi-claude-auth/clusters` | All functional areas |
| `gitnexus://repo/pi-claude-auth/processes` | All execution flows |
| `gitnexus://repo/pi-claude-auth/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
