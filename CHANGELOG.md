# Changelog

## 0.3.0

### Fixes

- macOS: disambiguate Keychain credential items by service **and** account. When
  two items share the `Claude Code-credentials` service (a legacy `default` and
  the current username account), `security -s` returned an arbitrary — often
  stale — item, causing persistent 401s that re-running `claude` could not fix.
  The dump is now parsed per item, reads pass `-a <account>`, accounts are sorted
  by expiry (freshest is default), and write-back targets the exact item it read.
  Legacy service-only sources keep working. Based on upstream PR #5 by
  @mattsegura.

## 0.2.0

Fork of `@pankajudhas81/pi-claude-auth`.

### Fixes

- Concurrency-safe `auth.json` sync: write via a temp file + atomic rename, skip
  the write on a torn/malformed read (so a concurrent pi writer's other
  providers are never clobbered), and no-op when the `anthropic` entry is already
  in sync. Based on upstream PR #3 by @itsmingjie.
- Replace shell `execSync` credential subprocess calls (Claude CLI refresh,
  macOS Keychain reads) with `execFileSync` argument arrays — no shell parsing,
  smaller attack surface. From @ftriquet's hardening audit.

### Changed

- Bump the pinned Claude Code version (`CC_VERSION`) to `2.1.252` for the billing
  header and user-agent.

# [0.1.0](https://github.com/pankajudhas81/pi-claude-auth/compare/v0.0.1...v0.1.0) (2026-05-30)

## 0.0.1

### Features

- Initial release. Pi coding agent extension that authenticates against
  Anthropic using your existing Claude Code credentials — no separate login
  or API key needed.
- Reads OAuth credentials from the macOS Keychain (all
  `Claude Code-credentials*` entries) with automatic multi-account detection,
  falling back to `~/.claude/.credentials.json` on all platforms.
- Seeds and syncs credentials into pi's `~/.pi/agent/auth.json` so pi uses
  them with zero separate login. Background re-sync runs every 5 minutes.
- Refreshes expiring tokens directly via Anthropic's OAuth endpoint (zero LLM
  tokens consumed), falling back to the Claude CLI, and writes rotated tokens
  back to the Keychain or credentials file.
- Account switcher via `/login anthropic` when multiple Claude Code accounts
  are detected; selection persists across sessions.
- Diagnostic logging via `PI_CLAUDE_AUTH_DEBUG` with automatic secret
  redaction.
