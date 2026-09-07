import { mkdirSync, rmdirSync, statSync, utimesSync } from "node:fs"
import { resolve } from "node:path"

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
    // Resolved, because pi locks the resolved path: a lock on a differently
    // spelled path would guard nothing while looking like it does.
    const path = `${resolve(target)}.lock`

    let owned: number
    if (create(path)) {
        const created = mtimeMsOrNull(path)
        if (created === null) return null // removed under us; not ours
        owned = created
    } else {
        const claimed = claimIfStale(path, options.staleMs)
        if (claimed === null) return null
        owned = claimed
    }

    const compromised = new AbortController()

    // Keep the lock young so a live holder is never mistaken for a dead one,
    // and notice at the same time if someone took it from us. Frequent enough
    // that a stolen lock is detected well within one Claude CLI run.
    const updateMs = Math.min(options.staleMs / 2, 5_000)
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

/**
 * Take over a lock nobody has refreshed for `staleMs`, or return null.
 *
 * Claiming is a write-then-verify on the mtime rather than rmdir+mkdir: a
 * removal followed by a creation lets a second taker delete the directory the
 * first one just made, so both would believe they hold the lock and only the
 * update timer would notice — too late, since a `claude` refresh finishes
 * inside that interval. Writing a mtime nobody else can produce and reading it
 * back narrows the ambiguity to the gap between those two syscalls, and the
 * loser learns immediately.
 *
 * It also interoperates with a holder that uses rmdir+mkdir (pi's library): if
 * it removed the directory first, the claim throws ENOENT and we yield; if we
 * claimed first, its staleness check no longer fires and it yields.
 *
 * Claims are whole milliseconds drawn from a small random backdate, so two
 * claims either coincide exactly (~1 in 4096) or differ by at least the
 * millisecond the comparison can resolve. Sub-millisecond randomness would be
 * useless here: two processes claiming within the same millisecond would read
 * back each other's value as their own.
 */
function claimIfStale(path: string, staleMs: number): number | null {
    if (ageMs(path) <= staleMs) return null

    // Backdating stays far below staleMs, so the claim cannot make the lock we
    // just took look abandoned.
    const spreadMs = Math.min(4096, staleMs / 4)
    const claimMs = Date.now() - Math.floor(Math.random() * spreadMs)
    try {
        utimesSync(path, claimMs / 1000, claimMs / 1000)
    } catch {
        return null // vanished or not ours to touch
    }
    const after = mtimeMsOrNull(path)
    return after !== null && Math.abs(after - claimMs) < 1 ? after : null
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

function mtimeMsOrNull(path: string): number | null {
    try {
        return mtimeMs(path)
    } catch {
        return null
    }
}

function ageMs(path: string): number {
    try {
        return Date.now() - mtimeMs(path)
    } catch {
        // Vanished between create and stat: treat as free.
        return Number.POSITIVE_INFINITY
    }
}
