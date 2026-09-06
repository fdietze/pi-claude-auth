import { randomUUID } from "node:crypto"
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeSync,
} from "node:fs"
import { dirname } from "node:path"

/** Handle for a held lock. Release exactly once, in a `finally`. */
export interface FileLock {
    release(): void
}

/**
 * Cross-process mutex built on an exclusive file create (O_EXCL), which is
 * atomic on every filesystem we care about. No dependency, no daemon, and the
 * lock is visible in the filesystem when debugging.
 *
 * Non-blocking by design (single attempt): waiting is policy and belongs to the
 * caller, which can do something more useful than sleeping — see
 * credential-store.ts, where waiters watch the credential source instead.
 *
 * Returns null when another process holds the lock.
 */
export function tryAcquireFileLock(
    path: string,
    options: { staleMs: number },
): FileLock | null {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

    // Identifies this holder so a release can never delete a lock that a stale
    // takeover has already handed to someone else.
    const token = `${process.pid}:${randomUUID()}`

    if (!create(path, token)) {
        // A lock older than staleMs was left behind by a crashed or killed
        // holder. Two waiters can delete it concurrently, but only one of them
        // can win the exclusive create afterwards, so the mutex still holds.
        if (!isStale(path, options.staleMs)) return null
        rmSync(path, { force: true })
        if (!create(path, token)) return null
    }

    return {
        release: () => {
            try {
                if (readFileSync(path, "utf-8") === token) {
                    rmSync(path, { force: true })
                }
            } catch {
                // Already gone (stale takeover, manual cleanup): nothing to do.
            }
        },
    }
}

function create(path: string, token: string): boolean {
    let fd: number
    try {
        fd = openSync(path, "wx", 0o600)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
        throw err
    }
    try {
        writeSync(fd, token)
    } finally {
        closeSync(fd)
    }
    return true
}

function isStale(path: string, staleMs: number): boolean {
    try {
        return Date.now() - statSync(path).mtimeMs > staleMs
    } catch {
        // Vanished between create and stat: treat as free.
        return true
    }
}
