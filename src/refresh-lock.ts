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
    /**
     * Aborts when the lock is compromised, i.e. another process took it over
     * while we still held it. Whatever the holder started must stop then:
     * "at most one `claude` refresh per machine" has to be enforced, not merely
     * made unlikely by timeout margins.
     */
    readonly signal: AbortSignal
    release(): Promise<void>
}

/**
 * A crashed holder's lock is taken over after this long.
 *
 * proper-lockfile refreshes the lock's mtime every stale/2 while the holder
 * lives, so this bounds recovery from a dead holder, not the duration of a
 * refresh. Deliberately generous: a suspended laptop or a blocked event loop
 * must not get a live holder declared dead. It exceeds the waiters' budget in
 * credential-store.ts, so a crashed holder costs a waiting request one
 * transient failure before the next attempt can take the lock over — which
 * beats stalling every request for the full staleness window.
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
    const target = getRefreshLockTarget()
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })

    const compromised = new AbortController()

    let release: () => Promise<void>
    try {
        release = await lockfile.lock(target, {
            // Without realpath resolution the target file never has to exist:
            // the lock is the sibling directory `<target>.lock`.
            realpath: false,
            retries: 0,
            stale: STALE_MS,
            onCompromised: (err) => {
                // Our lock was taken over while we still hold it. Whoever took
                // it may already be running `claude`, so ours must stop.
                log("refresh_lock_compromised", { error: err.message })
                compromised.abort(err)
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
        signal: compromised.signal,
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
