import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { acquireDirLock, type DirLock } from "./dir-lock.ts"
import { log } from "./logger.ts"
import { getRefreshLockTarget } from "./paths.ts"

/**
 * A crashed holder's lock is taken over after this long.
 *
 * The holder keeps its lock young while it lives, so this bounds recovery from
 * a dead holder, not the duration of a refresh. Deliberately generous: a
 * suspended laptop or a blocked event loop must not get a live holder declared
 * dead. It exceeds the waiters' budget in credential-store.ts, so a crashed
 * holder costs a waiting request one transient failure before the next attempt
 * can take the lock over — which beats stalling every request for the full
 * staleness window.
 */
const STALE_MS = 120_000

/**
 * Take the machine-wide Claude refresh lock, or return null when another
 * process holds it (the caller decides how to wait — see credential-store.ts).
 *
 * The returned lock's `signal` aborts if the lock is taken over while we hold
 * it: whatever the holder started must stop then, because "at most one `claude`
 * refresh per machine" has to be enforced, not merely made unlikely by timeout
 * margins.
 */
export function acquireRefreshLock(): DirLock | null {
    const target = getRefreshLockTarget()
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })

    const lock = acquireDirLock(target, { staleMs: STALE_MS })
    if (!lock) return null

    lock.signal.addEventListener(
        "abort",
        () => log("refresh_lock_compromised", {}),
        { once: true },
    )
    return lock
}
