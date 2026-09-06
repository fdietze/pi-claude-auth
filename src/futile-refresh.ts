import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getPiAgentDir } from "./paths.ts"

/**
 * Record that asking the Claude CLI to refresh achieved nothing for a specific
 * credential state.
 *
 * `state` identifies that state: the source's cheap stamp (file mtime/size) or
 * expiry, plus whether the credentials were still usable. Repeating a refresh
 * for a state we already asked about is pure cost — the answer cannot differ —
 * so the retry triggers are exactly the two things that change the state:
 * Claude Code writing new credentials, or the token crossing its expiry. No
 * timers, no backoff.
 *
 * Shared through a file because a machine typically runs many pi processes; one
 * process learning that a refresh is futile spares all the others their own
 * `claude` run.
 */
export interface FutileRefresh {
    source: string
    state: string
}

function markerPath(): string {
    return join(getPiAgentDir(), "claude-refresh-futile.json")
}

export function readFutileRefresh(): FutileRefresh | null {
    try {
        const parsed = JSON.parse(readFileSync(markerPath(), "utf-8")) as
            | Partial<FutileRefresh>
            | undefined
        if (typeof parsed?.source !== "string") return null
        if (typeof parsed.state !== "string") return null
        return { source: parsed.source, state: parsed.state }
    } catch {
        // Missing or unreadable: treat as "nothing known".
        return null
    }
}

/** Records a futile refresh, or clears the record when passed null. */
export function writeFutileRefresh(marker: FutileRefresh | null): void {
    const path = markerPath()
    try {
        if (!marker) {
            rmSync(path, { force: true })
            return
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, JSON.stringify(marker), "utf-8")
    } catch {
        // Non-fatal: the record is an optimization, not a correctness
        // requirement. Without it we simply retry the refresh.
    }
}
