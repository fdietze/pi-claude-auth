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
    LoginUnusable,
    NO_CREDENTIALS_MESSAGE,
} from "./credential-store.ts"
import {
    keychainContainerPath,
    readAccountCredentials,
    readAllClaudeAccounts,
    type ClaudeAccount,
    type ClaudeCredentials,
} from "./keychain.ts"
import { log } from "./logger.ts"
import { getClaudeCredentialsPath, getPiAgentDir } from "./paths.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

/** mtime and size of a file; "absent" while it does not exist. */
function statStamp(path: string): string {
    try {
        const stats = statSync(path)
        return `${stats.mtimeMs}:${stats.size}`
    } catch {
        return "absent"
    }
}

/**
 * Change token for a credential source: one stat of the file that stores it, so
 * an external rewrite (the Claude CLI or another pi process refreshing) is
 * visible to every instance on its next request. The credentials file is its
 * own container; a Keychain item lives in a keychain file. Null means "cannot
 * tell", which makes the store re-read instead of trusting its copy.
 */
function stampSource(source: string): string | null {
    if (source === "file") return statStamp(getClaudeCredentialsPath())
    const container = keychainContainerPath(source)
    return container === null ? null : statStamp(container)
}

const store = new CredentialStore({
    readSource: readAccountCredentials,
    stampSource,
    runClaudeRefresh: refreshViaClaudeCli,
    now: Date.now,
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
 * they are at or near expiry (see CredentialStore.ensureFresh). Throws with an actionable message when no usable
 * credentials can be obtained.
 */
export async function refreshActiveCredentials(
    signal?: AbortSignal,
): Promise<ClaudeCredentials> {
    const account = getActiveAccount()
    if (!account) throw new LoginUnusable(NO_CREDENTIALS_MESSAGE)
    try {
        return await store.ensureFresh(account.source, signal)
    } catch (err) {
        // Only a dead source justifies looking elsewhere. A slow refresh or an
        // unrunnable CLI affect every account equally, and switching accounts
        // over them would silently move the user to another subscription.
        // A canceled caller gets the original error, never a fallback.
        if (!(err instanceof LoginUnusable) || signal?.aborted) throw err
        // The account list is a snapshot from startup. On macOS, logging in
        // again can make Claude Code write a *different* Keychain item, which
        // would leave this process pinned to a dead one for its whole life.
        // Re-reading the list costs a subprocess, so it happens only here, on a
        // path that has already failed.
        const replacement = pickUsableAccount(
            refreshAccountsList(),
            account.source,
            Date.now(),
        )
        if (!replacement) throw err
        log("account_rediscovered", {
            previousSource: account.source,
            newSource: replacement.source,
            newLabel: replacement.label,
        })
        // Deliberately not persisted: this is a fallback for an unusable
        // account, not the user's choice in `/login`.
        setActiveAccountSource(replacement.source)
        return store.ensureFresh(replacement.source, signal)
    }
}

/**
 * The freshest still-valid account other than the one that just failed, or null
 * when there is none. Exported for tests.
 */
export function pickUsableAccount(
    accounts: ClaudeAccount[],
    failedSource: string,
    now: number,
): ClaudeAccount | null {
    return (
        accounts.find(
            (a) => a.source !== failedSource && a.credentials.expiresAt > now,
        ) ?? null
    )
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
