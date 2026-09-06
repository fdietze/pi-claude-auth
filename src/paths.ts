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
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
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
 * Lock file that serializes the delegated Claude CLI refresh across every pi
 * process on the machine, so at most one `claude` refresh runs at a time.
 */
export function getRefreshLockPath(): string {
    return join(getPiAgentDir(), "claude-refresh.lock")
}
