import type { FileLock } from "./file-lock.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import { log } from "./logger.ts"

/**
 * How much validity we require before considering credentials usable.
 *
 * pi refreshes an OAuth credential as soon as it is within five minutes of
 * expiry (pi-ai's DEFAULT_OAUTH_MINIMUM_VALIDITY_MS). Our threshold must not be
 * shorter: otherwise pi would ask us to refresh, we would answer "still fresh",
 * and pi would ask again on the very next request.
 */
export const MIN_VALIDITY_MS = 5 * 60_000

/**
 * How long a waiter watches for another process's refresh result.
 *
 * pi holds its own auth.json lock while awaiting our refresh and treats that
 * lock as stale after 30s, so a refresh that takes longer is discarded by pi
 * even when it succeeded (the request fails once, the retry then finds the
 * fresh credentials immediately). Waiting far past that budget only delays the
 * failure, so waiters give up well before it.
 */
const LOCK_WAIT_MS = 25_000
const LOCK_POLL_MS = 250

/**
 * When to consider the refresh lock abandoned. Must exceed the Claude CLI
 * timeout in claude-cli.ts, otherwise a slow-but-alive refresh would be
 * declared dead and a second CLI would start.
 */
export const REFRESH_LOCK_STALE_MS = 120_000

export const LOGIN_EXPIRED_MESSAGE =
    "Claude Code login expired or revoked. Run `claude` and log in, then retry."

export const REFRESH_BUSY_MESSAGE =
    "Another pi process is refreshing the Claude Code credentials. Retry in a moment."

export const NO_CREDENTIALS_MESSAGE =
    "No Claude Code credentials found. Run `claude` to authenticate first."

/**
 * Everything the store does to the outside world. Injected so the policy can be
 * tested without a real `claude`, real files or real waiting.
 */
export interface CredentialStoreDeps {
    /** Read the credentials a source currently holds. */
    readSource(source: string): ClaudeCredentials | null
    /**
     * Cheap change token for a source (file: mtime and size), or null when the
     * source has no cheap way to detect changes (macOS Keychain).
     */
    stampSource(source: string): string | null
    /** Try to take the machine-wide refresh lock; null when held elsewhere. */
    acquireRefreshLock(): FileLock | null
    /** Delegate a refresh to the Claude CLI. */
    runClaudeRefresh(): Promise<void>
    now(): number
    sleep(ms: number): Promise<void>
}

interface Snapshot {
    stamp: string | null
    credentials: ClaudeCredentials | null
}

/**
 * Reads Claude Code credentials and, when they expire, has the Claude CLI
 * refresh them — exactly once machine-wide.
 *
 * pi is a pure reader here: it never rotates the single-use refresh token,
 * because a second rotator racing Claude Code gets the session revoked.
 */
export class CredentialStore {
    private readonly deps: CredentialStoreDeps
    private readonly snapshots = new Map<string, Snapshot>()

    constructor(deps: CredentialStoreDeps) {
        this.deps = deps
    }

    /**
     * Freshest known credentials for a source. Re-reads only when the source
     * changed; never spawns anything, so it is safe on the request path.
     */
    read(source: string): ClaudeCredentials | null {
        const cached = this.snapshots.get(source)
        if (cached && cached.stamp !== null) {
            // A source with a stamp (the credentials file) is re-read only when
            // it actually changed. Keychain sources have no stamp and stay on
            // the in-memory copy until an expiry forces a re-read.
            if (this.deps.stampSource(source) === cached.stamp) {
                return cached.credentials
            }
        } else if (cached) {
            return cached.credentials
        }
        return this.reload(source).credentials
    }

    /** Drop the in-memory copy, e.g. after the user switched accounts. */
    forget(source: string): void {
        this.snapshots.delete(source)
    }

    /**
     * Credentials valid for at least MIN_VALIDITY_MS, delegating a refresh to
     * the Claude CLI when needed. Throws with an actionable message when no
     * usable credentials can be obtained.
     */
    async ensureFresh(source: string): Promise<ClaudeCredentials> {
        const known = this.read(source)
        if (known && this.isFresh(known)) return known

        // The source is authoritative: the Claude CLI (or another pi process)
        // may have refreshed since our last read.
        const current = this.reload(source)
        if (current.credentials && this.isFresh(current.credentials)) {
            return current.credentials
        }

        log("refresh_needed", {
            source,
            expiresAt: current.credentials?.expiresAt,
        })
        return this.delegateRefresh(source)
    }

    private isFresh(creds: ClaudeCredentials): boolean {
        return creds.expiresAt > this.deps.now() + MIN_VALIDITY_MS
    }

    private reload(source: string): Snapshot {
        // Stamp before content: if the source changes in between, the stamp we
        // stored is the older one and the next read sees a mismatch and
        // re-reads. The reverse order could cache new content under an old
        // stamp and miss the change.
        const stamp = this.deps.stampSource(source)
        const credentials = this.deps.readSource(source)
        const snapshot = { stamp, credentials }
        this.snapshots.set(source, snapshot)
        return snapshot
    }

    private async delegateRefresh(source: string): Promise<ClaudeCredentials> {
        const deadline = this.deps.now() + LOCK_WAIT_MS
        for (;;) {
            const lock = this.deps.acquireRefreshLock()
            if (lock) {
                try {
                    return await this.refreshUnderLock(source)
                } finally {
                    lock.release()
                }
            }

            // Another pi process is refreshing. Its result lands in the shared
            // source, so watch that instead of the lock: we are usually done
            // before the holder even releases.
            const waited = this.reload(source)
            if (waited.credentials && this.isFresh(waited.credentials)) {
                log("refresh_by_other_process", { source })
                return waited.credentials
            }
            if (this.deps.now() >= deadline) {
                log("refresh_lock_timeout", { source })
                throw new Error(REFRESH_BUSY_MESSAGE)
            }
            await this.deps.sleep(LOCK_POLL_MS)
        }
    }

    private async refreshUnderLock(source: string): Promise<ClaudeCredentials> {
        // Double-check under the lock: the previous holder may have just
        // refreshed, in which case a second CLI run would be pure waste.
        const before = this.reload(source)
        if (before.credentials && this.isFresh(before.credentials)) {
            return before.credentials
        }

        log("refresh_started", { source })
        try {
            await this.deps.runClaudeRefresh()
        } catch (err) {
            // A failing CLI can still have refreshed the credentials, so the
            // re-read below decides, not this error.
            log("refresh_command_failed", {
                source,
                error: err instanceof Error ? err.message : String(err),
            })
        }

        const after = this.reload(source)
        if (after.credentials && this.isFresh(after.credentials)) {
            log("refresh_success", { source })
            return after.credentials
        }

        log("refresh_exhausted", {
            source,
            expiresAt: after.credentials?.expiresAt,
        })
        throw new Error(
            after.credentials ? LOGIN_EXPIRED_MESSAGE : NO_CREDENTIALS_MESSAGE,
        )
    }
}
