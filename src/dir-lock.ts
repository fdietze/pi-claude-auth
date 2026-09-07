import { mkdirSync, rmdirSync, statSync, utimesSync } from "node:fs"

/**
 * A held lock. `release()` never throws; a lock that was taken over is simply
 * not removed again.
 */
export interface DirLock {
    /** Aborts when another process took this lock over while we held it. */
    readonly signal: AbortSignal
    release(): void
}

export interface DirLockOptions {
    /** A lock not refreshed for this long belongs to a dead holder. */
    staleMs: number
}

/**
 * Cross-process mutex: `mkdir` of `<target>.lock`.
 *
 * Directory creation is atomic on every filesystem we care about, and this is
 * exactly the on-disk protocol proper-lockfile implements — so a lock taken
 * here excludes pi, which uses that library for auth.json. It is re-implemented
 * rather than depended upon because pi runs on an embedded Bun whose `node:fs`
 * is a Proxy: proper-lockfile caches a Symbol on the fs module object, and
 * reading it back trips the Proxy invariant and kills pi on the second lock in
 * a process.
 *
 * Non-blocking by design (a single attempt): waiting is policy and belongs to
 * the caller.
 *
 * Returns null when another process holds the lock.
 */
export function acquireDirLock(
    target: string,
    options: DirLockOptions,
): DirLock | null {
    const path = `${target}.lock`

    if (!create(path)) {
        // Only a lock nobody refreshes any more may be taken over. Two waiters
        // can do that at the same time and both end up believing they hold it;
        // the update below detects that within one interval and compromises the
        // loser, which is what makes the takeover safe rather than merely rare.
        if (ageMs(path) <= options.staleMs) return null
        try {
            rmdirSync(path)
        } catch {
            // Someone else got there first; the create below decides.
        }
        if (!create(path)) return null
    }

    const compromised = new AbortController()
    let owned = mtimeMs(path)

    // Keep the lock young so a live holder is never mistaken for a dead one,
    // and notice at the same time if someone took it from us. Frequent enough
    // that a stolen lock is detected well within one Claude CLI run.
    const updateMs = Math.min(options.staleMs / 2, 15_000)
    const updater = setInterval(() => {
        try {
            if (mtimeMs(path) !== owned) throw new Error("lock taken over")
            const now = new Date()
            utimesSync(path, now, now)
            owned = mtimeMs(path)
        } catch (err) {
            clearInterval(updater)
            compromised.abort(err)
        }
    }, updateMs)
    // The lock must never keep a pi process alive.
    updater.unref()

    return {
        signal: compromised.signal,
        release: () => {
            clearInterval(updater)
            try {
                // Removing a lock that is no longer ours would hand a second
                // holder's mutex to a third process.
                if (mtimeMs(path) === owned) rmdirSync(path)
            } catch {
                // Already gone.
            }
        },
    }
}

function create(path: string): boolean {
    try {
        mkdirSync(path)
        return true
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
        throw err
    }
}

function mtimeMs(path: string): number {
    return statSync(path).mtimeMs
}

function ageMs(path: string): number {
    try {
        return Date.now() - mtimeMs(path)
    } catch {
        // Vanished between create and stat: treat as free.
        return Number.POSITIVE_INFINITY
    }
}
