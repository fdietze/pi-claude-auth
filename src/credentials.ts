import {
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { refreshViaClaudeCli } from "./claude-cli.ts"
import {
    CredentialStore,
    NO_CREDENTIALS_MESSAGE,
    REFRESH_LOCK_STALE_MS,
} from "./credential-store.ts"
import { tryAcquireFileLock } from "./file-lock.ts"
import {
    readAccountCredentials,
    readAllClaudeAccounts,
    type ClaudeAccount,
    type ClaudeCredentials,
} from "./keychain.ts"
import { readUnusableLogin, writeUnusableLogin } from "./login-marker.ts"
import { log } from "./logger.ts"
import {
    getClaudeCredentialsPath,
    getPiAgentDir,
    getRefreshLockPath,
} from "./paths.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

/**
 * Change token for a credential source.
 *
 * The credentials file gets mtime and size, which is one stat call and makes an
 * external rewrite (the Claude CLI refreshing) immediately visible. The macOS
 * Keychain has no equivalent cheap check — reading it costs a `security`
 * subprocess — so it returns null, meaning "no cheap change detection".
 */
function stampSource(source: string): string | null {
    if (source !== "file") return null
    try {
        const stats = statSync(getClaudeCredentialsPath())
        return `${stats.mtimeMs}:${stats.size}`
    } catch {
        return "absent"
    }
}

const store = new CredentialStore({
    readSource: readAccountCredentials,
    stampSource,
    acquireRefreshLock: () =>
        tryAcquireFileLock(getRefreshLockPath(), {
            staleMs: REFRESH_LOCK_STALE_MS,
        }),
    runClaudeRefresh: refreshViaClaudeCli,
    readUnusableLogin,
    writeUnusableLogin,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

export function initAccounts(accounts: ClaudeAccount[]): void {
    allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
    return allAccounts
}

export function setActiveAccountSource(source: string): void {
    const previous = activeAccountSource
    activeAccountSource = source
    store.forget(source)
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

/**
 * Active account's credentials as currently stored by Claude Code, re-read only
 * when the source changed. Never spawns anything, so it is safe on the request
 * path; returns null when no account or source is readable.
 */
export function getActiveCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null
    return store.read(account.source)
}

/**
 * Active account's credentials, delegating a refresh to the Claude CLI when
 * they are at or near expiry. Throws with an actionable message when no usable
 * credentials can be obtained.
 */
export async function refreshActiveCredentials(): Promise<ClaudeCredentials> {
    const account = getActiveAccount()
    if (!account) throw new Error(NO_CREDENTIALS_MESSAGE)
    return store.ensureFresh(account.source)
}

/**
 * Message for the user when the stored Claude Code login is known to be
 * unusable and nothing has changed since, null otherwise. Never spawns
 * anything.
 */
export function getLoginProblem(): string | null {
    const account = getActiveAccount()
    if (!account) return null
    return store.loginProblem(account.source)
}
