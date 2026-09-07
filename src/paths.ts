import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolve pi's agent config directory.
 *
 * Honors PI_CODING_AGENT_DIR (the same override pi itself respects), falling
 * back to the default `~/.pi/agent`. All credential and log artifacts live
 * under this directory so the extension stays consistent with pi's layout.
 */
export function getPiAgentDir(): string {
    const configured = process.env.PI_CODING_AGENT_DIR
    if (!configured) return join(homedir(), ".pi", "agent")
    // pi expands a leading ~ in this variable. Resolving it differently would
    // point us at a different auth.json than pi uses — and our lock on that
    // file would then guard nothing.
    if (configured === "~") return homedir()
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
        return join(homedir(), configured.slice(2))
    }
    return configured
}

/** Absolute path to pi's auth.json (where credentials are persisted). */
export function getAuthJsonPath(): string {
    return join(getPiAgentDir(), "auth.json")
}

/**
 * Absolute path to Claude Code's credentials file. Source of truth on Linux
 * and Windows; on macOS Claude Code uses the Keychain instead.
 */
export function getClaudeCredentialsPath(): string {
    return join(homedir(), ".claude", ".credentials.json")
}

/**
 * What the delegated Claude CLI refresh is locked on, so at most one `claude`
 * refresh runs per machine. The lock itself is the sibling directory
 * `claude-refresh.lock` (see dir-lock.ts); this path is only its name and is
 * never written.
 */
export function getRefreshLockTarget(): string {
    return join(getPiAgentDir(), "claude-refresh")
}
