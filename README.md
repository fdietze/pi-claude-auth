# pi-claude-auth

Self-contained Anthropic auth for the [pi coding agent](https://pi.dev) using
your existing Claude Code credentials — no separate login or API key needed.

## Quick start

```bash
pi install git:github.com/fdietze/pi-claude-auth@v0.3.0
```

Restart pi, pick a model with `/model` (or Ctrl+L). Done — your Claude Code
credentials are already seeded.

> This fork is distributed via git tags, not npm. Pin to a tag (e.g. `@v0.3.0`)
> for a reproducible install; use `@main` to track the latest.

## Prerequisites

> **Claude Code must be installed and authenticated first.**
>
> The extension reads from your macOS Keychain entry
> `Claude Code-credentials`. Run `claude` at least once so the entry exists.
> On Linux/Windows, `~/.claude/.credentials.json` is used instead.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
  installed and authenticated (run `claude` at least once), and the `claude`
  command on your `PATH` — the extension delegates every token refresh to it
- [pi](https://pi.dev) **0.85 or newer** installed
  (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`)
- macOS preferred (uses Keychain). Linux and Windows work via the credentials
  file fallback.

## Installation

### Option A: pi package manager (recommended)

```bash
pi install git:github.com/fdietze/pi-claude-auth@v0.3.0
```

pi clones the tag into `~/.pi/agent/git/` and loads the extension straight from
`src/index.ts`, running `npm install` for its single runtime dependency
(`proper-lockfile`, the same auth.json locking pi uses). Use `-l` for a
project-local install.

### Option B: Declare in settings.json (dotfiles-friendly)

Add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
    "packages": ["git:github.com/fdietze/pi-claude-auth@v0.3.0"]
}
```

Then just run `pi`. The extension loads automatically.

### Option C: Let an LLM do it

Paste this into any LLM agent (pi, Claude Code, Cursor, etc.):

```
Install the pi-claude-auth package and configure it by following:
https://raw.githubusercontent.com/fdietze/pi-claude-auth/main/installation.md
```

### Updating

Move to a newer tag (or `main`) by reinstalling at the new ref:

```bash
pi install git:github.com/fdietze/pi-claude-auth@v0.3.0
```

## Verify it's working

After installation, run:

```bash
pi config
```

You should see the extension listed:

```
git:github.com/fdietze/pi-claude-auth@v0.3.0 (user)
  Extensions
    [x] src/index.ts
```

Then start pi and pick any Claude model with `/model`. If it responds, auth is
working.

## Usage

Run `pi`, then pick a Claude model with `/model` (or Ctrl+L). The extension has
already seeded your Claude Code credentials, so there is nothing else to do — no
`/login`, no API key. When the token expires, pi asks the `claude` CLI to
refresh it; Claude Code stays the only writer of your credentials.

If your Claude Code login expires or is revoked, pi shows
"Claude Code login expired or revoked. Run `claude` and log in, then retry."
until you do. Nothing is retried in the meantime — the retry happens by itself
once Claude Code has written new credentials.

If your Claude Code credentials aren't OAuth-based, the extension stays out of
the way and pi falls through to its standard Anthropic auth.

## Why pi-claude-auth?

There are several good community projects solving Anthropic auth for pi (see
[Acknowledgements](#acknowledgements)). Here's what makes this one different:

- **Zero-login** — if Claude Code is authenticated, pi works immediately. No
  browser OAuth dance, no `/login`, no API key. Install and go.
- **Keychain-native** — reads directly from macOS Keychain (the same secure
  storage Claude Code uses). No credential files to manage on macOS.
- **Multi-account switching** — detects all Claude Code accounts automatically.
  Switch via `/login` when you have multiple accounts (Pro, Max, etc.).
- **Never rotates your tokens** — Claude Code is the single writer of its
  credentials. pi only reads them and asks the `claude` CLI to refresh, so the
  single-use refresh token is never redeemed twice (which would revoke the
  session and log you out of Claude Code).
- **One refresh per machine** — a lock file serializes the delegated refresh
  across all pi processes, so running many pi instances cannot start a storm of
  `claude` refreshes.

If you prefer a browser-based OAuth flow or need relay/caching features,
check out [pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth)
or [@cortexkit/pi-anthropic-auth](https://pi.dev/packages/@cortexkit/pi-anthropic-auth)
— both are solid options.

## Supported models

16 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-0            |
| claude-opus-4-1            |
| claude-opus-4-1-20250805   |
| claude-opus-4-20250514     |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-sonnet-4-0          |
| claude-sonnet-4-20250514   |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |

## Credential sources

The extension checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts
   are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

## Multiple accounts (macOS)

If you have multiple Claude Code accounts authenticated on macOS, the extension
detects all of them from the Keychain automatically. Each account is labeled by
its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts:

```
/login
```

Select the `anthropic` provider, then pick the account you want. Your selection
is persisted across sessions in `~/.pi/agent/claude-account-source.txt`. If only
one account is found, the picker is skipped.

## Troubleshooting

| Problem                                | Solution                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| "No Claude Code credentials found"     | Run `claude` to authenticate with Claude Code first                             |
| "Keychain is locked"                   | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`            |
| "Claude Code login expired or revoked" | Run `claude` and log in. pi picks the new credentials up by itself              |
| "Another pi process is refreshing"     | Transient: another pi instance holds the refresh lock. Send the request again   |
| Not working on Linux/Windows           | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it          |
| Keychain access denied                 | Grant access when macOS prompts you                                             |
| Keychain read timed out                | Restart Keychain Access (can happen on macOS Tahoe)                             |
| Package not updating                   | Reinstall at the ref: `pi install git:github.com/fdietze/pi-claude-auth@v0.3.0` |

### Claude Code version pinning

The Claude Code version is pinned to `2.1.252` for billing header computation.
If billing reverts to extra usage after a Claude Code update, override:

```bash
export ANTHROPIC_CLI_VERSION=<new-version>
```

or reinstall at a newer tag:

```bash
pi install git:github.com/fdietze/pi-claude-auth@v0.3.0
```

### Diagnostic logging

If you hit auth errors that are hard to reproduce, enable debug logging to
capture the full auth flow:

```bash
export PI_CLAUDE_AUTH_DEBUG=1
```

Restart pi and reproduce the issue. The extension writes structured JSON logs to
`~/.pi/agent/pi-claude-auth-debug.log`. All secrets (tokens, API keys) are
automatically redacted — the log file is safe to share when reporting an issue.

To write logs to a custom path:

```bash
export PI_CLAUDE_AUTH_DEBUG=/tmp/pi-claude-auth-debug.log
```

Disable when done:

```bash
unset PI_CLAUDE_AUTH_DEBUG
```

## Environment variables

| Variable                | Description                                                             | Default       |
| ----------------------- | ----------------------------------------------------------------------- | ------------- |
| `PI_CODING_AGENT_DIR`   | pi's config directory (where `auth.json` lives)                         | `~/.pi/agent` |
| `PI_CLAUDE_AUTH_DEBUG`  | Enable diagnostic logging (`1` for default path, or a custom file path) | disabled      |
| `ANTHROPIC_CLI_VERSION` | Claude CLI version for billing headers                                  | `2.1.160`     |

## How it works

This is a pi [extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
(packaged as a pi package) that sources Anthropic credentials from Claude Code
instead of asking you to log in again. The governing rule: **Claude Code is the
only writer of its credentials, pi only reads them.** Claude's OAuth refresh
tokens are single-use, so a second party redeeming one gets the whole session
revoked server-side — that is what logs you out of Claude Code.

On startup it reads your Claude Code OAuth tokens from the macOS Keychain (or
`~/.claude/.credentials.json` on other platforms) and seeds them into pi's
`~/.pi/agent/auth.json` under the `anthropic` provider — **without** the refresh
token, so no pi process can ever redeem it. pi then uses those credentials with
zero separate login.

When the token is within five minutes of expiry, pi calls this extension's
refresh hook, which:

1. takes a machine-wide lock file (`~/.pi/agent/claude-refresh.lock`),
2. re-reads the credentials — another pi process or Claude Code itself may have
   refreshed already, in which case it is done,
3. otherwise runs `claude -p . --model haiku` once, which makes Claude Code
   refresh and store its own tokens, and re-reads them.

Other pi processes watch the credential source while they wait, so they pick up
the result without starting a second `claude`.

If the refresh cannot produce usable credentials, the failure is recorded in
`~/.pi/agent/claude-login-unusable.json` together with a stamp of the credential
state that failed. While that state is unchanged, nothing is retried — no
subprocess, no network, no timer — and pi tells you to run `claude`. Logging in
again changes the stamp, which is what makes the next attempt happen.

### Technical details

- Reads all `Claude Code-credentials*` Keychain entries on macOS (labeled by
  subscription tier), falling back to `~/.claude/.credentials.json`
- Re-reads the credentials file when its mtime or size changed (one `stat`),
  so a refresh by Claude Code or another pi process is picked up immediately.
  The Keychain has no cheap equivalent, so those sources are re-read on expiry
- Seeds `~/.pi/agent/auth.json` with `{ type: "oauth", access, refresh: "",
expires }` under `anthropic`, using the same `proper-lockfile` protocol pi
  itself uses for that file
- Registers an `anthropic` OAuth provider override via
  `pi.registerProvider("anthropic", { oauth })`:
    - `login` reads the Keychain/file (no browser) and exposes an account picker
      when multiple accounts exist
    - `refreshToken` delegates to the `claude` CLI under the refresh lock
    - `getApiKey` only reads; it never triggers a refresh
- pi's built-in Anthropic provider applies the Claude Code identity, beta flags,
  and tool-name conventions for OAuth tokens, so requests look like Claude Code
- If credentials aren't OAuth-based or can't be read, the extension disables
  itself and pi continues with its standard Anthropic auth

### Limitation: refreshing a second macOS account

A delegated refresh refreshes whichever account the `claude` CLI itself is
logged into. If you selected a different Keychain account via `/login` and it
expires, pi cannot refresh it and asks you to run `claude` for that account.

## Acknowledgements

This is a fork of
[@pankajudhas81/pi-claude-auth](https://github.com/pankajudhas81/pi-claude-auth)
by Pankaj Udhas. It adds concurrency-safe `auth.json` writes based on
[#3](https://github.com/pankajudhas81/pi-claude-auth/pull/3) by
[@itsmingjie](https://github.com/itsmingjie), shell-free credential subprocess
calls (`execFileSync`) from
[@ftriquet](https://github.com/ftriquet)'s hardening audit, macOS multi-account
Keychain disambiguation from
[#5](https://github.com/pankajudhas81/pi-claude-auth/pull/5) by
[@mattsegura](https://github.com/mattsegura), and bumps the pinned Claude Code
version. All credit for the original design belongs upstream.

The upstream project is motivated by and copies patterns from
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)
by Griffin Martin. That project solved the same problem for
[opencode](https://github.com/nichochar/opencode) — reusing Claude Code OAuth
credentials so you don't need a separate login. We adopted the same approach
(Keychain reading, token refresh, credential seeding) and adapted it for pi's
extension API.

The community has built several other great solutions worth checking out:

- **[pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth)** by
  Leo Henon — a browser-based OAuth flow for pi. Uses a local callback server
  for a full OAuth dance via `/login anthropic`. Different approach from ours
  (browser login vs. Keychain reading), well-maintained, and popular (39 stars).
  If you prefer authenticating directly through Anthropic's login page rather
  than piggybacking on Claude Code credentials, this is a great choice.

- **[@cortexkit/pi-anthropic-auth](https://pi.dev/packages/@cortexkit/pi-anthropic-auth)**
  by ismeth / CortexKit — a shared-core monorepo supporting both pi and OpenCode
  through `@cortexkit/anthropic-auth-core`. Offers advanced features like relay
  proxying via Cloudflare Workers, prompt caching controls (`/claude-cache`),
  quota management, fast-mode for Opus, and routing strategies. The most
  feature-rich option in this space (1,540 downloads/mo). If you need caching,
  relay, or quota features, check this one out.

All three projects (and ours) exist because the community wants to use pi with
Claude Pro/Max subscriptions. Different approaches, same goal. Pick whichever
fits your workflow best.

## Disclaimer

This extension uses Claude Code's OAuth credentials to authenticate with
Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max
subscription tokens should only be used with official Anthropic clients. This
extension exists as a community workaround and may stop working if Anthropic
changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
