import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import lockfile from "proper-lockfile"
import { log } from "./logger.ts"
import { getRefreshLockTarget } from "./paths.ts"

/**
 * Held refresh lock. Release exactly once, in a `finally`. Releasing never
 * throws: a lock that was taken over rejects on release, and losing a good
 * refresh to that would be absurd.
 */
export interface RefreshLock {
    release(): Promise<void>
}

/**
 * A crashed holder's lock is taken over after this long.
 *
 * proper-lockfile refreshes the lock's mtime every stale/2 while the holder
 * lives, so this bounds recovery from a dead holder, not the duration of a
 * refresh. It must stay below the waiters' budget in credential-store.ts —
 * otherwise a crashed holder makes every waiter give up before takeover is even
 * possible — and far enough above stale/2 that a briefly blocked event loop
 * cannot get a live holder declared dead. Two `claude` runs at once are the
 * token-rotation race this lock exists to prevent.
 */
const STALE_MS = 60_000

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
    const target = getRefreshLockTarget()
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })

    let release: () => Promise<void>
    try {
        release = await lockfile.lock(target, {
            // Without realpath resolution the target file never has to exist:
            // the lock is the sibling directory `<target>.lock`.
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
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ELOCKED") return null
        // Anything else (permissions, read-only or full filesystem) is a real
        // problem the user has to see: reporting it as contention would send
        // them to wait for a refresh that can never happen.
        throw new Error(
            `Cannot lock the Claude refresh lock at ${target}.lock: ${
                err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
        )
    }

    return {
        release: async () => {
            try {
                await release()
            } catch (err) {
                log("refresh_lock_release_failed", {
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        },
    }
}
