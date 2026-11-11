# pi-claude-auth

Self-contained Anthropic auth for the [pi coding agent](https://pi.dev) using
your existing Claude Code credentials — no separate login or API key needed.

## Quick start

```bash
pi install git:github.com/fdietze/pi-claude-auth@main
```

Restart pi, pick a model with `/model` (or Ctrl+L). Done — your Claude Code
credentials are already seeded.

> This fork is distributed as source on the `main` branch, not npm. `@main`
> tracks the latest; for an exact, reproducible pin append a commit SHA
> (`@<sha>`) instead.

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
pi install git:github.com/fdietze/pi-claude-auth@main
```

pi clones `main` into `~/.pi/agent/git/` and loads the extension straight from
`src/index.ts` (it has no runtime dependencies). Use `-l` for a project-local
install.

### Option B: Declare in settings.json (dotfiles-friendly)

Add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
    "packages": ["git:github.com/fdietze/pi-claude-auth@main"]
}
```

Then just run `pi`. The extension loads automatically.

### Option C: Nix flake

The extension is a plain source tree with no runtime dependencies, so a Nix
setup consumes it directly — no npm, no pi package manager. Add it as a
`flake = false` input and link its `src/` into pi's extension directory:

```nix
# flake.nix
inputs.pi-claude-auth = {
  url = "github:fdietze/pi-claude-auth";
  flake = false;
};
```

```nix
# home-manager
home.file.".pi/agent/extensions/pi-claude-auth".source =
  "${inputs.pi-claude-auth}/src";
```

`nix flake update` then upgrades the extension with every other input. pi loads
`src/index.ts` from the linked directory on startup.

### Option D: Let an LLM do it

Paste this into any LLM agent (pi, Claude Code, Cursor, etc.):

```
Install the pi-claude-auth package and configure it by following:
https://raw.githubusercontent.com/fdietze/pi-claude-auth/main/installation.md
```

### Updating

Reinstall to pull the latest `main`:

```bash
pi install git:github.com/fdietze/pi-claude-auth@main
```

## Verify it's working

After installation, run:

```bash
pi config
```

You should see the extension listed:

```
git:github.com/fdietze/pi-claude-auth@main (user)
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

pi asks for a refresh five minutes before expiry. The extension then starts
the `claude` refresh in the background and keeps serving the still-valid token;
the next request picks up the new one. Only an already expired token makes the
request wait. A cold refresh can outlast pi's 15s refresh budget; pi then reports
"A Claude Code credential refresh is still running. Retry in a moment." Canceling
stops the waiting, not the refresh.

If a completed CLI attempt leaves the credentials unrefreshed, pi asks you to
run `claude` and log in, then retry. This does not prove the login was revoked:
a completed command can fail because of a network error. Each pi process
remembers that unchanged state and does not retry until Claude Code writes new
credentials or the token crosses its expiry. A timeout (60s) is transient and
not remembered.

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
- **Claude-owned token rotation** — pi never redeems or stores Claude's refresh
  token. It asks the `claude` CLI to refresh its own credentials instead.
- **One token rotation, however many sessions** — concurrent refreshes from
  any number of pi processes and Claude Code sessions are serialized by Claude
  Code's own refresh lock, which re-reads the token under the lock.

If you prefer a browser-based OAuth flow or need relay/caching features,
check out [pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth)
or [@cortexkit/pi-anthropic-auth](https://pi.dev/packages/@cortexkit/pi-anthropic-auth)
— both are solid options.

## Models

pi manages the model catalog; this extension only supplies authentication and
Claude Code billing headers. Use `/model` to select a Claude model. Actual
availability depends on Anthropic and your account. See [pi's model catalog](https://pi.dev/models).

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

| Problem                                                                      | Solution                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No Claude Code credentials found"                                           | Run `claude` to authenticate with Claude Code first                                                                                                                                                                                                           |
| "Keychain is locked"                                                         | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                                                                                                                                          |
| "Claude Code login expired or revoked"                                       | Run `claude` and log in. pi picks the new credentials up by itself                                                                                                                                                                                            |
| "A Claude Code credential refresh is still running"                          | The delegated `claude` refresh outlasted pi's 15s budget. Retry in a moment                                                                                                                                                                                   |
| `OAuth refresh failed ... 400 invalid_request_error` from a session/subagent | That pi session did not load this extension, so it hit pi's built-in refresh on the empty stored token. Load the extension in **every** pi session that uses these credentials, including subagents (e.g. add it to actor-subagents' `child-extensions.json`) |
| Not working on Linux/Windows                                                 | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it                                                                                                                                                                                        |
| Keychain access denied                                                       | Grant access when macOS prompts you                                                                                                                                                                                                                           |
| Keychain read timed out                                                      | Restart Keychain Access (can happen on macOS Tahoe)                                                                                                                                                                                                           |
| Package not updating                                                         | Reinstall at the ref: `pi install git:github.com/fdietze/pi-claude-auth@main`                                                                                                                                                                                 |

### Claude Code version

The billing header and user-agent carry the version printed by `claude --version`,
read once at startup. If `claude` cannot be run, the extension falls back to
`2.1.299`. If billing reverts to extra usage after a Claude Code update,
override:

```bash
export ANTHROPIC_CLI_VERSION=<version>
```

or reinstall to pull the latest `main`:

```bash
pi install git:github.com/fdietze/pi-claude-auth@main
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

| Variable                | Description                                                             | Default                            |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| `PI_CODING_AGENT_DIR`   | pi's config directory (where `auth.json` lives)                         | `~/.pi/agent`                      |
| `PI_CLAUDE_AUTH_DEBUG`  | Enable diagnostic logging (`1` for default path, or a custom file path) | disabled                           |
| `ANTHROPIC_CLI_VERSION` | Claude CLI version for billing headers                                  | `claude --version`, else `2.1.299` |

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
refresh hook while holding its `auth.json` lock. The hook:

1. re-reads the credentials — Claude Code or another pi process may have
   refreshed already, in which case it is done,
2. otherwise starts `claude -p "only say OK" --model haiku --effort low` (once
   per pi process; concurrent requests join it), which makes Claude Code
   refresh and store its own tokens. `ANTHROPIC_API_KEY` and
   `ANTHROPIC_AUTH_TOKEN` are stripped from that run: the CLI would
   authenticate with them instead of the Claude Code login, and the refresh
   would silently change nothing,
3. returns the current token at once if it is still valid, so pi's lock is
   released immediately; only an expired token waits for the run and its
   re-read.

Claude Code's own refresh lock guarantees a single rotation across all
concurrent `claude` runs. After 60s the run gets SIGTERM, and SIGKILL 5s later:
on SIGTERM, Claude Code waits for an in-flight token refresh before exiting.
A forced kill during rotation can still require a new Claude Code login.

### Technical details

- Reads all `Claude Code-credentials*` Keychain entries on macOS (labeled by
  subscription tier), falling back to `~/.claude/.credentials.json`
- Re-reads the credentials when the file storing them changed (mtime or size,
  one `stat`), so a refresh by Claude Code or another pi process is picked up
  immediately. For a Keychain item that file is the keychain database `security`
  reports for it; when it is unknown, the Keychain is read on every request
- Seeds `~/.pi/agent/auth.json` with `{ type: "oauth", access, refresh: "",
expires }` under `anthropic`, holding the same `<file>.lock` directory pi's
  own locking uses, and replacing the file through a rename
- Registers an `anthropic` OAuth provider override via
  `pi.registerProvider("anthropic", { oauth })`:
    - `login` reads the Keychain/file (no browser) and exposes an account picker
      when multiple accounts exist
    - `refreshToken` delegates to the `claude` CLI
    - `getApiKey` only reads; it never triggers a refresh
- pi's built-in Anthropic provider applies the Claude Code identity, beta flags,
  and tool-name conventions for OAuth tokens, so requests look like Claude Code
- If credentials aren't OAuth-based or can't be read, the extension disables
  itself and pi continues with its standard Anthropic auth

### Limitation: refreshing a second macOS account

A delegated refresh refreshes whichever account the `claude` CLI itself is
logged into. If you selected a different Keychain account via `/login` and it
expires, pi cannot refresh it: it falls back to another Claude Code account that
is still valid (for this session only, your `/login` choice is kept), and
otherwise asks you to run `claude` for that account.

### Uninstalling

The extension seeds an `anthropic` entry in `~/.pi/agent/auth.json`, and a
stored credential outranks `ANTHROPIC_API_KEY`. Run `/logout` and pick
`anthropic` after removing the package, or start pi once with the extension
still installed and Claude Code logged out — it then removes its own entry.

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
