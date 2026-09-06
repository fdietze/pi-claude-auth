import { CLAUDE_TIMEOUT_MS, ClaudeCliUnavailable } from "./claude-cli.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import type { FutileRefresh } from "./futile-refresh.ts"
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
 * Bounded by what actually bounds the holder — the Claude CLI timeout — plus a
 * margin for reading the result. Giving up earlier would turn a refresh that
 * did succeed into a failed request for every waiter, and losing a refresh is
 * worse than waiting for one.
 */
const LOCK_WAIT_MS = CLAUDE_TIMEOUT_MS + 10_000
const LOCK_POLL_MS = 250

export const LOGIN_EXPIRED_MESSAGE =
    "Claude Code login expired or revoked. Run `claude` and log in, then retry."

export const REFRESH_BUSY_MESSAGE =
    "Another pi process is refreshing the Claude Code credentials. Retry in a moment."

export const CLAUDE_UNAVAILABLE_MESSAGE =
    "Could not run the `claude` CLI to refresh the Claude Code credentials. Make sure it is installed and on PATH."

export const NO_CREDENTIALS_MESSAGE =
    "No Claude Code credentials found. Run `claude` to authenticate first."

/**
 * Everything the store does to the outside world. Injected so the policy can be
 * tested without a real `claude`, real files or real waiting.
 */
export interface RefreshLock {
    release(): Promise<void>
}

export interface CredentialStoreDeps {
    /** Read the credentials a source currently holds. */
    readSource(source: string): ClaudeCredentials | null
    /**
     * Cheap change token for a source (file: mtime and size), or null when the
     * source has no cheap way to detect changes (macOS Keychain).
     */
    stampSource(source: string): string | null
    /** Try to take the machine-wide refresh lock; null when held elsewhere. */
    acquireRefreshLock(): Promise<RefreshLock | null>
    /** Delegate a refresh to the Claude CLI. */
    runClaudeRefresh(): Promise<void>
    /** Read the shared record of a refresh that achieved nothing. */
    readFutileRefresh(): FutileRefresh | null
    /** Record a futile refresh, or clear the record when passed null. */
    writeFutileRefresh(marker: FutileRefresh | null): void
    now(): number
    sleep(ms: number): Promise<void>
}

interface Snapshot {
    stamp: string | null
    credentials: ClaudeCredentials | null
}

/**
 * What a source looks like right now, condensed to what the refresh policy
 * needs: an identity that changes whenever a retry could produce a different
 * answer, and whether the credentials still work at all.
 */
interface SourceState {
    identity: string
    usable: boolean
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
     * Message to show when the credentials are unusable and a refresh for
     * exactly this state has already been tried in vain, null otherwise. Costs
     * one stat and one small file read, so it is safe to call on every session
     * start and every request.
     */
    loginProblem(source: string): string | null {
        const marker = this.deps.readFutileRefresh()
        if (!marker || marker.source !== source) return null
        const state = this.stateOf(source)
        if (state.usable) return null
        return marker.state === state.identity ? LOGIN_EXPIRED_MESSAGE : null
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

        // Asking again for a state we already asked about cannot give a new
        // answer, so spend nothing on it.
        const state = stateOf(current, this.deps.now())
        const marker = this.deps.readFutileRefresh()
        if (marker?.source === source && marker.state === state.identity) {
            log("refresh_skipped_futile", { source, usable: state.usable })
            if (state.usable && current.credentials) return current.credentials
            throw new Error(LOGIN_EXPIRED_MESSAGE)
        }

        return this.delegateRefresh(source)
    }

    private stateOf(source: string): SourceState {
        // read() re-reads only when the source changed, so this stays cheap.
        this.read(source)
        const snapshot = this.snapshots.get(source)
        return stateOf(
            snapshot ?? { stamp: null, credentials: null },
            this.deps.now(),
        )
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
            const lock = await this.deps.acquireRefreshLock()
            if (lock) {
                try {
                    return await this.refreshUnderLock(source)
                } finally {
                    await lock.release()
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

        // It may also have learned that refreshing this exact state achieves
        // nothing. Checking only before queueing for the lock would let every
        // waiting process repeat the same futile CLI run in turn.
        const stateBefore = stateOf(before, this.deps.now())
        const marker = this.deps.readFutileRefresh()
        if (
            marker?.source === source &&
            marker.state === stateBefore.identity
        ) {
            log("refresh_skipped_futile", {
                source,
                usable: stateBefore.usable,
                underLock: true,
            })
            if (stateBefore.usable && before.credentials) {
                return before.credentials
            }
            throw new Error(LOGIN_EXPIRED_MESSAGE)
        }

        log("refresh_started", { source })
        try {
            await this.deps.runClaudeRefresh()
        } catch (err) {
            if (err instanceof ClaudeCliUnavailable) {
                // The CLI never ran, so this says nothing about the login:
                // recording it would suppress refreshes for a state that was
                // never actually tried.
                log("refresh_cli_unavailable", { source, error: err.message })
                throw new Error(CLAUDE_UNAVAILABLE_MESSAGE, { cause: err })
            }
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
            this.deps.writeFutileRefresh(null)
            return after.credentials
        }

        // The CLI left this state as it was. Remember that, so no process asks
        // again until the state changes.
        const state = stateOf(after, this.deps.now())
        this.deps.writeFutileRefresh({ source, state: state.identity })
        log("refresh_ineffective", {
            source,
            expiresAt: after.credentials?.expiresAt,
            usable: state.usable,
        })

        // Credentials short of our safety margin but not actually expired still
        // work: returning them beats failing the request. The Claude CLI
        // refreshes for certain once they are past expiry, which changes the
        // state and lets the next attempt through.
        if (state.usable && after.credentials) return after.credentials

        throw new Error(
            after.credentials ? LOGIN_EXPIRED_MESSAGE : NO_CREDENTIALS_MESSAGE,
        )
    }
}

/**
 * Identity plus usability of a snapshot.
 *
 * The identity is the cheap stamp when the source has one, otherwise the
 * expiry, and always carries the usability: a token that was merely close to
 * expiry when we asked is a different state once it is actually expired, and
 * asking again is then worth it — the CLI refuses to refresh a token it still
 * considers good, but always refreshes an expired one.
 */
function stateOf(snapshot: Snapshot, now: number): SourceState {
    const creds = snapshot.credentials
    const usable = creds !== null && creds.expiresAt > now
    const base = snapshot.stamp ?? `expires:${creds?.expiresAt ?? "none"}`
    return {
        identity: `${base}|${creds ? (usable ? "usable" : "expired") : "missing"}`,
        usable,
    }
}
