import { execFileSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
    readAccountCredentials,
    readAllClaudeAccounts,
    type ClaudeAccount,
    type ClaudeCredentials,
} from "./keychain.ts"
import { log } from "./logger.ts"
import { getAuthJsonPath, getPiAgentDir } from "./paths.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

const accountCacheMap = new Map<
    string,
    { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
    allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
    return allAccounts
}

export function setActiveAccountSource(source: string): void {
    const previous = activeAccountSource
    activeAccountSource = source
    accountCacheMap.delete(source)
    if (previous && previous !== source) {
        log("account_switch", { newSource: source, previousSource: previous })
    }
}

export function refreshAccountsList(): ClaudeAccount[] {
    allAccounts = readAllClaudeAccounts()
    return allAccounts
}

function getActiveAccount(): ClaudeAccount | null {
    if (allAccounts.length === 0) return null
    if (activeAccountSource) {
        const found = allAccounts.find((a) => a.source === activeAccountSource)
        if (found) return found
    }
    return allAccounts[0]
}

function getAccountStateFile(): string {
    return join(getPiAgentDir(), "claude-account-source.txt")
}

export function loadPersistedAccountSource(): string | null {
    try {
        const path = getAccountStateFile()
        if (existsSync(path)) {
            return readFileSync(path, "utf-8").trim() || null
        }
    } catch {
        // ignore
    }
    return null
}

export function saveAccountSource(source: string): void {
    try {
        const path = getAccountStateFile()
        const dir = dirname(path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path, source, "utf-8")
    } catch {
        // Non-fatal
    }
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
    let auth: Record<string, unknown> = {}
    if (existsSync(authPath)) {
        const raw = readFileSync(authPath, "utf-8").trim()
        if (raw) {
            try {
                auth = JSON.parse(raw)
            } catch {
                // Torn read from a concurrent writer. Rebuilding from {}
                // would drop other providers' credentials; skip and retry
                // on the next sync.
                log("sync_auth_json_skipped", {
                    path: authPath,
                    reason: "malformed or partially written auth.json",
                })
                return
            }
        }
    }
    // pi persists OAuth credentials as `{ type: "oauth", access, refresh,
    // expires }` keyed by provider id. Seeding the `anthropic` entry lets pi
    // use the Claude Code credentials with no separate /login.
    const entry = {
        type: "oauth",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
    const existing = auth.anthropic as Record<string, unknown> | undefined
    if (
        existing &&
        existing.type === entry.type &&
        existing.access === entry.access &&
        existing.refresh === entry.refresh &&
        existing.expires === entry.expires
    ) {
        return // unchanged; don't risk clobbering concurrent writers
    }
    auth.anthropic = entry
    const dir = dirname(authPath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    // Atomic replace so readers never see a partial file.
    const tmpPath = join(
        dir,
        `.auth.json.${process.pid}.${Date.now().toString(36)}.tmp`,
    )
    try {
        writeFileSync(tmpPath, JSON.stringify(auth, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        })
        if (process.platform !== "win32") {
            chmodSync(tmpPath, 0o600)
        }
        renameSync(tmpPath, authPath)
    } catch (err) {
        rmSync(tmpPath, { force: true })
        throw err
    }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
    const authPath = getAuthJsonPath()
    try {
        syncToPath(authPath, creds)
        log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
        log("sync_auth_json", {
            path: authPath,
            success: false,
            error: err instanceof Error ? err.message : String(err),
        })
        throw err
    }
}

function refreshViaCli(): void {
    const maxAttempts = 2
    for (let i = 0; i < maxAttempts; i++) {
        log("refresh_started", { source: "cli", attempt: i + 1 })
        try {
            // execFileSync (argument array, no shell) avoids shell parsing of
            // the command string — least attack surface for the CLI fallback.
            execFileSync("claude", ["-p", ".", "--model", "haiku"], {
                timeout: 60_000,
                encoding: "utf-8",
                env: { ...process.env, TERM: "dumb" },
                stdio: "ignore",
                cwd: tmpdir(),
            })
            log("refresh_success", { source: "cli" })
            return
        } catch (err) {
            log("refresh_failed", {
                source: "cli",
                attempt: i + 1,
                error: err instanceof Error ? err.message : String(err),
            })
            // Non-fatal: retry once, then give up
        }
    }
}

export function refreshIfNeeded(
    account?: ClaudeAccount,
): ClaudeCredentials | null {
    const target = account ?? getActiveAccount()
    if (!target) return null

    // Pick up external updates to .credentials.json (e.g. the Claude CLI
    // refreshing in another process). Bounded by getCachedCredentials's 30s
    // TTL. macOS keychain sources stay on the in-memory path.
    if (target.source === "file") {
        const onDisk = readAccountCredentials(target.source)
        if (onDisk) target.credentials = onDisk
    }

    const creds = target.credentials
    if (creds.expiresAt > Date.now() + 60_000) return creds

    log("refresh_needed", {
        source: target.source,
        expiresAt: creds.expiresAt,
        expiresIn: creds.expiresAt - Date.now(),
    })

    // Only the Claude CLI rotates the refresh token; pi delegates to it.
    refreshViaCli()
    const refreshed = readAccountCredentials(target.source)
    if (refreshed && refreshed.expiresAt > Date.now() + 60_000) {
        target.credentials = refreshed
        return refreshed
    }

    log("refresh_exhausted", {
        source: target.source,
        hadCredentials: !!refreshed,
        expiresAt: refreshed?.expiresAt,
    })
    return null
}

/**
 * Get fresh credentials for the active account. Used by pi's
 * `oauth.refreshToken` hook, which runs when the token stored in auth.json is
 * at/near expiry.
 *
 * Re-reads the source first (the Claude CLI may have already rotated the
 * token), then delegates a refresh to the Claude CLI.
 */
export function forceRefreshActiveCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    accountCacheMap.delete(account.source)

    // The on-disk/keychain source may already hold a fresher token.
    const onDisk = readAccountCredentials(account.source)
    if (onDisk) account.credentials = onDisk
    if (account.credentials.expiresAt > Date.now() + 60_000) {
        accountCacheMap.set(account.source, {
            creds: account.credentials,
            cachedAt: Date.now(),
        })
        return account.credentials
    }

    const fresh = refreshIfNeeded(account)
    if (fresh) {
        accountCacheMap.set(account.source, {
            creds: fresh,
            cachedAt: Date.now(),
        })
    }
    return fresh
}

/**
 * Returns the active account's credentials for auth.json sync purposes.
 * Unlike getCachedCredentials(), this does NOT trigger a refresh.
 * Returns null if no account or credentials are expired.
 */
export function getCredentialsForSync(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const creds = account.credentials
    if (creds.expiresAt > Date.now() + 60_000) {
        return creds
    }

    // Near expiry -- don't refresh here, let the per-request path handle it.
    return null
}

export function getCachedCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const now = Date.now()
    const cached = accountCacheMap.get(account.source)
    if (
        cached &&
        now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
        cached.creds.expiresAt > now + 60_000
    ) {
        log("cache_hit", {
            source: account.source,
            ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
        })
        return cached.creds
    }

    log("cache_miss", {
        source: account.source,
        reason: cached ? "stale or expiring" : "empty",
    })

    const fresh = refreshIfNeeded(account)
    if (!fresh) {
        log("credentials_unavailable", { source: account.source })
        accountCacheMap.delete(account.source)
        return null
    }

    accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
    return fresh
}
