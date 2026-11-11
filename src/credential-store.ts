import { ClaudeCliUnavailable, ClaudeRefreshTimedOut } from "./claude-cli.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import { log } from "./logger.ts"

/**
 * How much validity we require before considering credentials fresh.
 *
 * pi refreshes an OAuth credential as soon as it is within five minutes of
 * expiry (pi-ai's DEFAULT_OAUTH_MINIMUM_VALIDITY_MS). Our threshold must not be
 * shorter: otherwise pi would ask us to refresh, we would answer "still fresh",
 * and pi would ask again on the very next request. Claude Code refreshes from
 * the same five-minute margin, so a delegated run near expiry does rotate.
 */
export const MIN_VALIDITY_MS = 5 * 60_000

/**
 * A completed attempt left unusable credentials. A new login or source change
 * permits another attempt; this is not proof of permanent revocation.
 * Distinct from transient failures (a timeout, an unrunnable CLI), which say
 * nothing about the login and must not trigger fallbacks.
 */
export class LoginUnusable extends Error {}

export const LOGIN_EXPIRED_MESSAGE =
    "Claude Code login expired or revoked. Run `claude` and log in, then retry."

export const REFRESH_BUSY_MESSAGE =
    "A Claude Code credential refresh is still running. Retry in a moment."

export const CLAUDE_UNAVAILABLE_MESSAGE =
    "Could not run the `claude` CLI to refresh the Claude Code credentials. Make sure it is installed and on PATH."

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
     * Cheap change token for a source (mtime and size of the file storing it),
     * or null when it cannot be determined; null forces a re-read.
     */
    stampSource(source: string): string | null
    /** Delegate a refresh to the Claude CLI; only its own timeout stops it. */
    runClaudeRefresh(): Promise<void>
    now(): number
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
 * Reads Claude Code credentials and, when they near expiry, has the Claude CLI
 * refresh them.
 *
 * pi is a pure reader here: it never rotates the single-use refresh token,
 * because a second rotator racing Claude Code gets the session revoked. Claude
 * Code's own refresh lock makes concurrent CLI runs (from this or any other
 * process) rotate once, so this store only avoids redundant runs in-process.
 */
export class CredentialStore {
    private readonly deps: CredentialStoreDeps
    private readonly snapshots = new Map<string, Snapshot>()
    /** The CLI run per source; resolves to its failure, never rejects. */
    private readonly runs = new Map<string, Promise<unknown>>()
    /**
     * State identity a completed CLI run left unrefreshed, per source. The
     * same state cannot yield a different answer, so it is not asked about
     * again. In memory only: a new process retries once.
     */
    private readonly futile = new Map<string, string>()

    constructor(deps: CredentialStoreDeps) {
        this.deps = deps
    }

    /**
     * Freshest known credentials for a source. Re-reads only when the source
     * changed; never spawns anything, so it is safe on the request path.
     */
    read(source: string): ClaudeCredentials | null {
        const stamp = this.deps.stampSource(source)
        const cached = this.snapshots.get(source)
        // A copy is trusted only while its stamp is known and unchanged: no
        // stamp means no proof that it is still the token Claude Code holds.
        if (cached && stamp !== null && stamp === cached.stamp) {
            return cached.credentials
        }
        return this.reload(source, stamp).credentials
    }

    /** Drop the in-memory copy, e.g. after the user switched accounts. */
    forget(source: string): void {
        this.snapshots.delete(source)
    }

    /**
     * Message to show when the credentials are unusable and a refresh for
     * exactly this state has already been tried in vain, null otherwise. Costs
     * at most one stat and one read, so it is safe on every request.
     */
    loginProblem(source: string): string | null {
        const futile = this.futile.get(source)
        if (futile === undefined) return null
        const state = this.stateOf(source)
        if (state.usable) return null
        return futile === state.identity ? LOGIN_EXPIRED_MESSAGE : null
    }

    /**
     * Credentials to use now, delegating a refresh to the Claude CLI when they
     * near expiry. Returns still-usable credentials without waiting for that
     * run: pi calls this while holding its `auth.json` lock, which other pi
     * processes give up on after 30s. Waits (until `signal`) only when the
     * credentials are expired. Throws with an actionable message when no
     * usable credentials can be obtained.
     */
    async ensureFresh(
        source: string,
        signal?: AbortSignal,
    ): Promise<ClaudeCredentials> {
        signal?.throwIfAborted()
        const known = this.read(source)
        if (known && this.isFresh(known)) return known

        // The source is authoritative: the Claude CLI (or another pi process)
        // may have refreshed since our last read.
        const current = this.reload(source)
        if (current.credentials && this.isFresh(current.credentials)) {
            return current.credentials
        }

        const state = stateOf(current, this.deps.now())
        if (this.futile.get(source) === state.identity) {
            log("refresh_skipped_futile", { source, usable: state.usable })
            if (state.usable && current.credentials) return current.credentials
            throw new LoginUnusable(LOGIN_EXPIRED_MESSAGE)
        }

        const run = this.startRefresh(source)
        // The common case: pi asks five minutes early. The next request
        // re-reads whatever the run wrote.
        if (state.usable && current.credentials) return current.credentials

        let failure: unknown
        try {
            failure = await waitForCaller(run, signal)
        } catch (err) {
            // pi bounds refreshToken with a 15s AbortSignal.timeout, which a
            // cold CLI run can outlast. Its bare "The operation timed out"
            // hides that the run continues; say so instead.
            throw new Error(REFRESH_BUSY_MESSAGE, { cause: err })
        }

        const after = this.read(source)
        if (after && after.expiresAt > this.deps.now()) return after
        if (failure instanceof ClaudeRefreshTimedOut) throw failure
        if (failure instanceof ClaudeCliUnavailable) {
            throw new Error(CLAUDE_UNAVAILABLE_MESSAGE, { cause: failure })
        }
        throw new LoginUnusable(
            after ? LOGIN_EXPIRED_MESSAGE : NO_CREDENTIALS_MESSAGE,
        )
    }

    /** Start the CLI run for a source, or join the one in flight. */
    private startRefresh(source: string): Promise<unknown> {
        const inFlight = this.runs.get(source)
        if (inFlight) return inFlight
        // A failing re-read (e.g. a locked Keychain) must not reject a run
        // nobody may be waiting for.
        const run = this.refresh(source)
            .catch((err: unknown) => err)
            .finally(() => this.runs.delete(source))
        this.runs.set(source, run)
        return run
    }

    private async refresh(source: string): Promise<unknown> {
        log("refresh_started", { source })
        let failure: unknown
        try {
            await this.deps.runClaudeRefresh()
        } catch (err) {
            failure = err
            log("refresh_command_failed", { source, error: String(err) })
        }

        const after = this.reload(source)
        if (after.credentials && this.isFresh(after.credentials)) {
            log("refresh_success", { source })
            this.futile.delete(source)
            return failure
        }
        // A timeout or a missing CLI says nothing about this state; a later
        // request may try again.
        if (
            failure instanceof ClaudeRefreshTimedOut ||
            failure instanceof ClaudeCliUnavailable
        ) {
            return failure
        }
        // The CLI completed and left this state as it was. Crossing expiry or
        // a new credential write changes the identity and permits a retry.
        const state = stateOf(after, this.deps.now())
        this.futile.set(source, state.identity)
        log("refresh_ineffective", {
            source,
            expiresAt: after.credentials?.expiresAt,
            usable: state.usable,
        })
        return failure
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

    private reload(
        source: string,
        stamp: string | null = this.deps.stampSource(source),
    ): Snapshot {
        // Stamp before content: if the source changes in between, the stamp we
        // stored is the older one and the next read sees a mismatch and
        // re-reads. The reverse order could cache new content under an old
        // stamp and miss the change.
        const credentials = this.deps.readSource(source)
        const snapshot = { stamp, credentials }
        this.snapshots.set(source, snapshot)
        return snapshot
    }
}

/**
 * Identity plus usability of a snapshot.
 *
 * The identity is the cheap stamp when the source has one, otherwise the
 * expiry, and always carries the usability: a token that was merely close to
 * expiry when we asked is a different state once it is actually expired, and
 * asking again is then worth it — the CLI refuses to refresh a token it still
 * considers good, whereas expiry permits a useful retry.
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

/**
 * Wait for `job` until `signal` aborts. `job` must never reject: it may outlive
 * this wait unobserved.
 *
 * The run's child process and timers are unref'd, so while a caller waits
 * nothing else may keep the runtime alive (pi's AbortSignal.timeout does not):
 * a ref'd timer holds it open until the wait ends.
 */
function waitForCaller<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
    const keepAlive = setInterval(() => {}, 2 ** 30)
    if (!signal) return job.finally(() => clearInterval(keepAlive))
    return new Promise((resolve, reject) => {
        const done = () => {
            clearInterval(keepAlive)
            signal.removeEventListener("abort", abort)
        }
        const abort = () => {
            done()
            reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        job.then((value) => {
            done()
            resolve(value)
        })
        if (signal.aborted) abort()
    })
}
