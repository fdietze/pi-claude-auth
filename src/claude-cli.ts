import { spawn } from "node:child_process"
import { tmpdir } from "node:os"

/**
 * Upper bound for one delegated refresh. A cold `claude` start plus a Haiku
 * round trip is usually well under 20s; beyond a minute the CLI is stuck and
 * killing it is better than blocking the caller further.
 */
const CLAUDE_TIMEOUT_MS = 60_000

/**
 * Make the Claude CLI refresh its own OAuth credentials.
 *
 * Claude Code is the only writer of its credentials: OAuth refresh tokens are
 * single-use, so a second rotator (pi) racing Claude Code gets the session
 * revoked server-side and logs the user out. There is no documented "refresh
 * only" command, so we trigger the CLI's own refresh path with the cheapest
 * request available (Haiku, empty prompt) and then re-read what it wrote.
 *
 * Rejects when the CLI cannot be started, times out, or exits non-zero.
 */
export function refreshViaClaudeCli(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Argument array (no shell) keeps the attack surface minimal.
        // cwd=tmpdir avoids picking up the project's CLAUDE.md/settings, and
        // TERM=dumb keeps the CLI from emitting terminal control sequences.
        const child = spawn("claude", ["-p", ".", "--model", "haiku"], {
            cwd: tmpdir(),
            env: { ...process.env, TERM: "dumb" },
            stdio: "ignore",
            timeout: CLAUDE_TIMEOUT_MS,
        })
        child.on("error", reject)
        child.on("close", (code, signal) => {
            if (code === 0) resolve()
            else reject(new Error(`claude exited with ${signal ?? code}`))
        })
    })
}
