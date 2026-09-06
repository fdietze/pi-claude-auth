import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import lockfile from "proper-lockfile"
import type { ClaudeCredentials } from "./keychain.ts"
import { log } from "./logger.ts"
import { getAuthJsonPath } from "./paths.ts"

/** pi's on-disk credential shape for an OAuth provider. */
export interface PiOAuthCredential {
    type: "oauth"
    access: string
    refresh: string
    expires: number
}

/**
 * Map Claude Code credentials to pi's credential shape.
 *
 * The refresh token is deliberately left empty. Claude's OAuth refresh tokens
 * are single-use: whoever redeems one invalidates it for everyone else, and a
 * second redeemer gets the session revoked server-side — which logs the user
 * out of Claude Code itself. Refreshing therefore belongs to Claude Code alone,
 * and this extension's `oauth.refreshToken` override is the only refresh path
 * pi takes for the anthropic provider. Handing pi the real token would give a
 * second rotator the means to break the login; an empty one cannot.
 */
export function toPiOAuthCredential(
    creds: ClaudeCredentials,
): PiOAuthCredential {
    return {
        type: "oauth",
        access: creds.accessToken,
        refresh: "",
        expires: creds.expiresAt,
    }
}

/**
 * Seed the `anthropic` entry in pi's auth.json so pi authenticates as Claude
 * Code with no separate login. A stored credential outranks ANTHROPIC_API_KEY
 * in pi, so this entry is all it takes.
 *
 * Uses proper-lockfile with pi's own parameters: pi guards auth.json with that
 * exact protocol, and a second protocol on the same file would be a race by
 * construction.
 */
export async function seedAnthropicCredential(
    creds: ClaudeCredentials,
): Promise<void> {
    const path = getAuthJsonPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // proper-lockfile requires the target to exist before it can lock it.
    if (!existsSync(path)) {
        writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o600 })
    }

    const release = await lockAuthJson(path)
    try {
        const auth = JSON.parse(readFileSync(path, "utf-8") || "{}") as Record<
            string,
            unknown
        >
        const entry = toPiOAuthCredential(creds)
        if (isSameEntry(auth.anthropic, entry)) {
            log("seed_auth_json", { path, changed: false })
            return
        }
        auth.anthropic = entry
        writeFileSync(path, JSON.stringify(auth, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        })
        log("seed_auth_json", { path, changed: true })
    } finally {
        await release()
    }
}

/**
 * Take pi's own auth.json lock, with pi's parameters. The returned release
 * never throws: a compromised lock rejects on release, and letting that mask a
 * completed write would turn a success into a confusing failure.
 */
async function lockAuthJson(path: string): Promise<() => Promise<void>> {
    const release = await lockfile.lock(path, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 5, minTimeout: 50, maxTimeout: 1_000 },
    })
    return async () => {
        try {
            await release()
        } catch (err) {
            log("auth_json_lock_release_failed", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}

function isSameEntry(existing: unknown, entry: PiOAuthCredential): boolean {
    const current = existing as Partial<PiOAuthCredential> | undefined
    return (
        current?.type === entry.type &&
        current.access === entry.access &&
        current.refresh === entry.refresh &&
        current.expires === entry.expires
    )
}

/**
 * Remove the entry we seeded, if it is still ours.
 *
 * A seeded credential outranks ANTHROPIC_API_KEY, and it carries an empty
 * refresh token because only this extension's refresh hook may refresh it. Left
 * behind once the extension no longer supplies credentials, pi's built-in
 * anthropic OAuth would try to redeem that empty token and fail forever, hiding
 * an otherwise working API key. The `refresh: ""` shape identifies our own
 * entry, so a real credential from another source is never touched.
 */
export async function removeSeededCredential(): Promise<void> {
    const path = getAuthJsonPath()
    if (!existsSync(path)) return

    const release = await lockAuthJson(path)
    try {
        const auth = JSON.parse(readFileSync(path, "utf-8") || "{}") as Record<
            string,
            unknown
        >
        const existing = auth.anthropic as
            | Partial<PiOAuthCredential>
            | undefined
        if (existing?.type !== "oauth" || existing.refresh !== "") return
        delete auth.anthropic
        writeFileSync(path, JSON.stringify(auth, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        })
        log("removed_seeded_credential", { path })
    } finally {
        await release()
    }
}
