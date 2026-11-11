import { execFile, spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"

/**
 * Upper bound for one delegated refresh. A cold `claude` start plus a Haiku
 * round trip is usually well under 20s; beyond a minute the CLI is stuck and
 * killing it is better than blocking the caller further.
 */
export const CLAUDE_TIMEOUT_MS = 60_000

/**
 * The CLI could not be started at all (not installed, not on PATH, not
 * executable). Distinct from a CLI that ran and failed, because it says nothing
 * about the state of the login.
 */
export class ClaudeCliUnavailable extends Error {}

/**
 * The refresh outlasted CLAUDE_TIMEOUT_MS and was stopped. Transient: it says
 * nothing about the login, and rotation may or may not have completed.
 */
export class ClaudeRefreshTimedOut extends Error {}

/**
 * Auth sources that outrank the Claude Code login inside the CLI. With one of
 * these set, `claude` authenticates the refresh request with it and never
 * touches the OAuth token — the run succeeds and refreshes nothing.
 */
const OVERRIDING_AUTH_VARS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
] as const

/**
 * Environment for the delegated refresh.
 *
 * The run exists solely to make the CLI exercise its OAuth login, so any auth
 * source that would take precedence over that login is removed. Inheriting one
 * turns the refresh into a silent no-op: the CLI answers the prompt via the API
 * key, the credentials stay expired, and the caller reports the login as dead.
 *
 * TERM=dumb keeps the CLI from emitting terminal control sequences.
 *
 * Pure, so the policy is testable without spawning anything.
 */
export function buildRefreshEnv(
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, TERM: "dumb" }
    for (const name of OVERRIDING_AUTH_VARS) delete env[name]
    return env
}

/** Bound for `claude --version`: a cold, sandbox-wrapped start takes ~0.5s. */
const VERSION_TIMEOUT_MS = 3_000

/**
 * Semver at the start of `claude --version` output ("2.1.299 (Claude Code)"),
 * or null for anything else. Parse, don't validate: the version ends up in
 * request headers, so only a well-formed one may pass.
 *
 * Pure, exported for testing.
 */
export function parseClaudeVersion(stdout: string): string | null {
    return /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(stdout.trim())?.[1] ?? null
}

/**
 * The installed Claude Code version, or null when it cannot be determined
 * (not installed, timeout, unexpected output). Never rejects: callers fall back
 * to a pinned version (src/signing.ts), so a missing CLI must not break startup.
 */
export function readClaudeCliVersion(): Promise<string | null> {
    return new Promise((resolve) => {
        // Argument array, no shell; cwd=tmpdir as in refreshViaClaudeCli.
        execFile(
            "claude",
            ["--version"],
            {
                cwd: tmpdir(),
                timeout: VERSION_TIMEOUT_MS,
                encoding: "utf-8",
                windowsHide: true,
            },
            (error, stdout) =>
                resolve(error ? null : parseClaudeVersion(stdout)),
        )
    })
}

/**
 * Grace between SIGTERM and SIGKILL on timeout. On SIGTERM, Claude Code
 * 2.1.316 shuts down gracefully and waits up to 2s for an in-flight OAuth
 * refresh (`waitForHeldOAuthRefresh`), so a token it already redeemed still
 * gets written. An immediate SIGKILL could land between the token POST and
 * that write and lose the rotation.
 */
const KILL_GRACE_MS = 5_000

/**
 * Make the Claude CLI refresh its own OAuth credentials.
 *
 * Claude Code is the only writer of its credentials: OAuth refresh tokens are
 * single-use, so a second rotator (pi) racing Claude Code gets the session
 * revoked server-side and logs the user out. There is no documented "refresh
 * only" command, so we trigger the CLI's own refresh path with the cheapest
 * request available (Haiku, minimal effort, a prompt answerable in one word)
 * and then re-read what it wrote. Claude Code serializes concurrent refreshes
 * with its own lock and re-reads under it, so concurrent runs from many pi
 * processes still rotate the token once.
 *
 * Only the timeout stops the run; callers can stop waiting for it, never stop
 * it. The child is unref'd, so a run nobody waits for never keeps pi alive.
 *
 * Rejects when the CLI cannot be started, times out, or exits non-zero.
 */
export function refreshViaClaudeCli(): Promise<void> {
    // Argument array (no shell) keeps the attack surface minimal.
    // cwd=tmpdir avoids picking up the project's CLAUDE.md/settings.
    //
    // The prompt states the whole expected answer, and `--effort low`
    // keeps reasoning minimal: the run exists only to make the CLI perform
    // an authenticated request. A contentless prompt would still reach the
    // user's global CLAUDE.md and produce a chatty reply, spending output
    // tokens on text nobody reads. The `haiku` alias outlives any concrete
    // model id, so a retired model cannot break the refresh path.
    const child = spawn(
        "claude",
        ["-p", "only say OK", "--model", "haiku", "--effort", "low"],
        {
            cwd: tmpdir(),
            env: buildRefreshEnv(),
            stdio: "ignore",
            // Own process group, so the timeout reaches wrapper children too.
            detached: process.platform !== "win32",
        },
    )
    child.unref()
    return waitForClaudeRefresh(child)
}

/**
 * Settle when `child` exits; on timeout, SIGTERM its process group and SIGKILL
 * it after KILL_GRACE_MS. Exported for testing with fake children.
 */
export function waitForClaudeRefresh(
    child: ChildProcess,
    timeoutMs = CLAUDE_TIMEOUT_MS,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timedOut = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const timer = setTimeout(() => {
            timedOut = true
            signalGroup(child, "SIGTERM")
            killTimer = setTimeout(
                () => signalGroup(child, "SIGKILL"),
                KILL_GRACE_MS,
            )
            killTimer.unref()
        }, timeoutMs)
        timer.unref()
        const settle = (err: Error | null) => {
            clearTimeout(timer)
            clearTimeout(killTimer)
            if (err) reject(err)
            else resolve()
        }
        child.on("error", (err) => {
            // Without a pid nothing was started; any later error still ends
            // in "close", which settles.
            if (!child.pid) settle(new ClaudeCliUnavailable(err.message))
        })
        child.on("close", (code, killedBy) => {
            if (timedOut) {
                settle(
                    new ClaudeRefreshTimedOut(
                        `Claude refresh timed out after ${timeoutMs}ms`,
                    ),
                )
            } else if (code === 0) settle(null)
            else settle(new Error(`claude exited with ${killedBy ?? code}`))
        })
    })
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, signal)
        else child.kill(signal)
    } catch {
        // Already gone: "close" settles.
    }
}
