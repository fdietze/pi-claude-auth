import { spawn, type ChildProcess } from "node:child_process"
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

/** The refresh was stopped before it could finish. Transient, retryable. */
export class ClaudeRefreshAborted extends Error {}

/**
 * Make the Claude CLI refresh its own OAuth credentials.
 *
 * Claude Code is the only writer of its credentials: OAuth refresh tokens are
 * single-use, so a second rotator (pi) racing Claude Code gets the session
 * revoked server-side and logs the user out. There is no documented "refresh
 * only" command, so we trigger the CLI's own refresh path with the cheapest
 * request available (Haiku, minimal effort, a prompt answerable in one word)
 * and then re-read what it wrote.
 *
 * `signal` aborts the run — the caller uses it to guarantee that at most one
 * `claude` refresh exists per machine even when its lock is taken over.
 *
 * Rejects when the CLI cannot be started, is aborted, times out, or exits
 * non-zero.
 */
export function refreshViaClaudeCli(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        // Aborted before we start: an "abort" listener would never fire, and
        // spawning here would leave a CLI nothing stops.
        if (signal.aborted) {
            reject(new ClaudeRefreshAborted("refresh aborted"))
            return
        }

        // Argument array (no shell) keeps the attack surface minimal.
        // cwd=tmpdir avoids picking up the project's CLAUDE.md/settings, and
        // TERM=dumb keeps the CLI from emitting terminal control sequences.
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
                env: { ...process.env, TERM: "dumb" },
                stdio: "ignore",
                // Own process group, so stopping the refresh stops all of it:
                // the `claude` on PATH is often a wrapper script, and killing
                // just the direct child would leave the real CLI running —
                // precisely the second concurrent refresh the caller's lock
                // exists to prevent.
                detached: process.platform !== "win32",
            },
        )

        let stopped: "aborted" | "timeout" | null = null
        const stop = (reason: "aborted" | "timeout") => {
            stopped = reason
            kill(child)
        }
        const timer = setTimeout(() => stop("timeout"), CLAUDE_TIMEOUT_MS)
        const onAbort = () => stop("aborted")
        signal.addEventListener("abort", onAbort, { once: true })

        const settle = (err: Error | null) => {
            clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
            if (err) reject(err)
            else resolve()
        }

        child.on("error", (err) =>
            settle(
                stopped === "aborted"
                    ? new ClaudeRefreshAborted("refresh aborted")
                    : new ClaudeCliUnavailable(err.message),
            ),
        )
        child.on("close", (code, killedBy) => {
            if (stopped === "aborted") {
                settle(new ClaudeRefreshAborted("refresh aborted"))
            } else if (stopped === "timeout") {
                settle(
                    new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`),
                )
            } else if (code === 0) {
                settle(null)
            } else {
                settle(new Error(`claude exited with ${killedBy ?? code}`))
            }
        })
    })
}

/**
 * SIGKILL cannot be caught or ignored, so the process always dies and "close"
 * always fires — a CLI that swallowed SIGTERM would leave the refresh promise,
 * and with it the machine-wide lock, pending forever.
 */
function kill(child: ChildProcess): void {
    try {
        if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, "SIGKILL") // whole process group
        } else {
            child.kill("SIGKILL") // Windows has no process groups here
        }
    } catch {
        // Already gone.
    }
}
