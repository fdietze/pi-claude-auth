import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { acquireDirLock } from "./dir-lock.ts"
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
 * Locked with pi's own protocol and parameters: pi guards auth.json the same
 * way, and a second protocol on the same file would be a race by construction.
 */
export async function seedAnthropicCredential(
    creds: ClaudeCredentials,
): Promise<void> {
    const path = getAuthJsonPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

    await withAuthJsonLock(path, () => {
        const auth = readAuthJson(path)
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
    })
}

/**
 * pi's parameters for this file: it treats an auth.json lock older than 30s as
 * abandoned, so ours must age the same way to interlock with it.
 */
const AUTH_LOCK_STALE_MS = 30_000

/**
 * Writers only hold this lock for a read-modify-write of a small file, so
 * anything longer than a few seconds means something is wrong and failing is
 * more useful than waiting.
 */
const AUTH_LOCK_WAIT_MS = 5_000

async function withAuthJsonLock<T>(path: string, write: () => T): Promise<T> {
    const deadline = Date.now() + AUTH_LOCK_WAIT_MS
    for (;;) {
        const lock = acquireDirLock(path, { staleMs: AUTH_LOCK_STALE_MS })
        if (lock) {
            try {
                return write()
            } finally {
                lock.release()
            }
        }
        if (Date.now() >= deadline) {
            throw new Error(`auth.json stayed locked: ${path}.lock`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
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

    await withAuthJsonLock(path, () => {
        const auth = readAuthJson(path)
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
    })
}

function readAuthJson(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {}
    // Under the lock no writer is mid-write, so a parse error is a genuinely
    // broken file. Rebuilding from {} would silently drop other providers'
    // credentials, so the caller sees the error instead.
    return JSON.parse(readFileSync(path, "utf-8") || "{}") as Record<
        string,
        unknown
    >
}
