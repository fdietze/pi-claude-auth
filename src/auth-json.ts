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

    const release = await lockfile.lock(path, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 5, minTimeout: 50, maxTimeout: 1_000 },
    })
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

function isSameEntry(existing: unknown, entry: PiOAuthCredential): boolean {
    const current = existing as Partial<PiOAuthCredential> | undefined
    return (
        current?.type === entry.type &&
        current.access === entry.access &&
        current.refresh === entry.refresh &&
        current.expires === entry.expires
    )
}
