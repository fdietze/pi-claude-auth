import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import lockfile from "proper-lockfile"
import { log } from "./logger.ts"
import { getRefreshLockPath } from "./paths.ts"

/**
 * Held refresh lock. Release exactly once, in a `finally`.
 */
export interface RefreshLock {
    release(): Promise<void>
}

/**
 * A crashed holder's lock is taken over after this long. Well above the Claude
 * CLI timeout in claude-cli.ts, because a live holder must never be declared
 * dead: two `claude` runs at the same time are the token-rotation race this
 * lock exists to prevent. proper-lockfile refreshes the lock's mtime every
 * stale/2 while the holder lives, so only a truly dead holder ages out.
 */
const STALE_MS = 120_000

/**
 * Take the machine-wide Claude refresh lock, or return null when another
 * process holds it (the caller decides how to wait — see credential-store.ts).
 *
 * proper-lockfile rather than a hand-rolled lock: pi uses it for auth.json, it
 * survives SIGKILL through the stale timeout, and it keeps a live holder's lock
 * alive, which a plain O_EXCL file cannot do without re-inventing the same
 * machinery.
 */
export async function acquireRefreshLock(): Promise<RefreshLock | null> {
    const path = getRefreshLockPath()
    // proper-lockfile locks `<path>.lock` and requires <path> to exist.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 })

    try {
        const release = await lockfile.lock(path, {
            realpath: false,
            retries: 0,
            stale: STALE_MS,
            onCompromised: (err) => {
                // Our lock was taken over while we still hold it; a second
                // `claude` may now be running. Nothing to undo, but it explains
                // a surprising refresh in the log.
                log("refresh_lock_compromised", { error: err.message })
            },
        })
        return { release }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ELOCKED") {
            log("refresh_lock_error", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
        return null
    }
}
