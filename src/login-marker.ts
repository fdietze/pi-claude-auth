import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getPiAgentDir } from "./paths.ts"

/**
 * Record that the stored Claude Code login could not be refreshed.
 *
 * `stamp` identifies the exact credential state that failed (file mtime/size,
 * or the expiry for Keychain sources). While the source still carries that
 * stamp, retrying is pointless: nothing has changed and another `claude` run
 * would just cost time. A different stamp means the user logged in again, which
 * is the only retry trigger — no timers, no backoff.
 *
 * Shared through a file because a machine typically runs many pi processes;
 * one process discovering the dead login spares all the others their own
 * `claude` attempt.
 */
export interface UnusableLogin {
    source: string
    stamp: string
}

function markerPath(): string {
    return join(getPiAgentDir(), "claude-login-unusable.json")
}

export function readUnusableLogin(): UnusableLogin | null {
    try {
        const parsed = JSON.parse(readFileSync(markerPath(), "utf-8")) as
            | Partial<UnusableLogin>
            | undefined
        if (typeof parsed?.source !== "string") return null
        if (typeof parsed.stamp !== "string") return null
        return { source: parsed.source, stamp: parsed.stamp }
    } catch {
        // Missing or unreadable: treat as "no known problem".
        return null
    }
}

/** Records a failed login, or clears the record when passed null. */
export function writeUnusableLogin(marker: UnusableLogin | null): void {
    const path = markerPath()
    try {
        if (!marker) {
            rmSync(path, { force: true })
            return
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, JSON.stringify(marker), "utf-8")
    } catch {
        // Non-fatal: the marker is an optimization, not a correctness
        // requirement. Without it we simply retry the refresh.
    }
}
