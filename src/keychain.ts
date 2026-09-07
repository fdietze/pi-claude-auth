import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { log } from "./logger.ts"
import { getClaudeCredentialsPath } from "./paths.ts"

export interface ClaudeCredentials {
    accessToken: string
    refreshToken: string
    expiresAt: number
    subscriptionType?: string
}

export interface ClaudeAccount {
    label: string
    source: string
    credentials: ClaudeCredentials
}

const PRIMARY_SERVICE = "Claude Code-credentials"

// A Keychain service name is NOT unique. `security` allows several generic
// password items to share one service as long as their account ("acct")
// attribute differs, and Claude Code has written its credentials under
// different account names over time (an older "default" and, currently, the
// macOS username). That leaves two live items under the service
// "Claude Code-credentials".
//
// `security find-generic-password -s <service> -w` returns only the FIRST
// match, with no defined ordering between same-service items. When the item it
// happens to return is a stale one, every read yields long-expired tokens and
// pi fails with a 401 even though the user is properly logged in to Claude
// Code. Identifying an item therefore requires the service AND the account.
const SOURCE_SEPARATOR = "\u0001"

export interface KeychainRef {
    service: string
    account?: string
}

/**
 * Encodes a service/account pair into the opaque `source` string used to
 * identify an account elsewhere in the extension.
 */
export function encodeSource(ref: KeychainRef): string {
    return ref.account
        ? `${ref.service}${SOURCE_SEPARATOR}${ref.account}`
        : ref.service
}

/**
 * Decodes a `source` string back into a service/account pair. Sources persisted
 * by earlier versions contain no separator and decode to a service-only ref, so
 * an existing `claude-account-source.txt` keeps working.
 */
export function decodeSource(source: string): KeychainRef {
    const idx = source.indexOf(SOURCE_SEPARATOR)
    if (idx === -1) return { service: source }
    return { service: source.slice(0, idx), account: source.slice(idx + 1) }
}

/**
 * Extracts every Claude Code credential item from `security dump-keychain`
 * output, keyed by service and account.
 *
 * Exported for testing.
 */
export function parseKeychainDump(dump: string): KeychainRef[] {
    // dump-keychain emits one record per item, each introduced by a
    // "keychain: ..." header. Splitting on that header keeps an item's "acct"
    // attribute associated with its own "svce", which is what makes multiple
    // accounts under a single service name distinguishable.
    const refs: KeychainRef[] = []
    const seen = new Set<string>()

    for (const record of dump.split(/^keychain: /m)) {
        const svcMatch =
            /"svce"<blob>="(Claude Code-credentials(?:-[0-9a-f]+)?)"/.exec(
                record,
            )
        if (!svcMatch) continue
        const acctMatch = /"acct"<blob>="([^"]*)"/.exec(record)
        const ref: KeychainRef = {
            service: svcMatch[1],
            account: acctMatch ? acctMatch[1] : undefined,
        }
        const key = encodeSource(ref)
        if (seen.has(key)) continue
        seen.add(key)
        refs.push(ref)
    }

    // Prefer the primary service so the canonical Claude Code entry remains the
    // default account when several are present.
    return [
        ...refs.filter((r) => r.service === PRIMARY_SERVICE),
        ...refs.filter((r) => r.service !== PRIMARY_SERVICE),
    ]
}

/**
 * Outcome of reading one credential store. "no-login" and "unreadable" are kept
 * apart on purpose: a store that we read successfully and that holds no login
 * proves the user is logged out, while a store we could not read proves
 * nothing — and only proof may drive destructive cleanup (see
 * removeSeededCredential).
 */
type ReadOutcome =
    | { kind: "credentials"; credentials: ClaudeCredentials }
    | { kind: "no-login" }
    | { kind: "unreadable" }

function parseCredentialsOutcome(raw: string): ReadOutcome {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { kind: "unreadable" }
    }

    const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
    const creds = data as {
        accessToken?: unknown
        refreshToken?: unknown
        expiresAt?: unknown
        subscriptionType?: unknown
        mcpOAuth?: unknown
    }

    // Entries that only contain mcpOAuth are MCP server credentials, not
    // user accounts.
    if ((parsed as { mcpOAuth?: unknown }).mcpOAuth && !creds.accessToken) {
        return { kind: "no-login" }
    }

    if (
        typeof creds.accessToken !== "string" ||
        typeof creds.refreshToken !== "string" ||
        typeof creds.expiresAt !== "number"
    ) {
        log("credentials_parsed", {
            hasAccessToken: typeof creds.accessToken === "string",
            hasRefreshToken: typeof creds.refreshToken === "string",
            hasExpiry: typeof creds.expiresAt === "number",
            isMcpOnly: false,
        })
        return { kind: "no-login" }
    }

    log("credentials_parsed", {
        hasAccessToken: true,
        hasRefreshToken: true,
        hasExpiry: true,
        isMcpOnly: false,
    })

    return {
        kind: "credentials",
        credentials: {
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            expiresAt: creds.expiresAt,
            subscriptionType:
                typeof creds.subscriptionType === "string"
                    ? creds.subscriptionType
                    : undefined,
        },
    }
}

function parseCredentials(raw: string): ClaudeCredentials | null {
    const outcome = parseCredentialsOutcome(raw)
    return outcome.kind === "credentials" ? outcome.credentials : null
}

function readKeychainService(ref: KeychainRef | string): string | null {
    const target = typeof ref === "string" ? decodeSource(ref) : ref
    const serviceName = target.service
    // execFileSync with an argument array avoids shell interpolation of the
    // service/account — least attack surface for the Keychain read.
    const args = ["find-generic-password", "-s", serviceName]
    // Without -a, `security` returns an arbitrary item among those sharing the
    // service, which may be a stale credential.
    if (target.account) args.push("-a", target.account)
    args.push("-w")
    try {
        const result = execFileSync("/usr/bin/security", args, {
            timeout: 2000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim()
        log("keychain_read", {
            service: serviceName,
            account: target.account,
            success: true,
        })
        return result
    } catch (err: unknown) {
        const error = err as {
            status?: number
            code?: string
            killed?: boolean
        }

        if (error.killed || error.code === "ETIMEDOUT") {
            log("keychain_read_error", {
                service: serviceName,
                errorType: "timeout",
            })
            throw new Error(
                "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
                { cause: err },
            )
        }
        if (error.status === 36) {
            log("keychain_read_error", {
                service: serviceName,
                errorType: "locked",
            })
            throw new Error(
                "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
                { cause: err },
            )
        }
        if (error.status === 128) {
            log("keychain_read_error", {
                service: serviceName,
                errorType: "denied",
            })
            throw new Error(
                "Keychain access was denied. Please grant access when prompted by macOS.",
                { cause: err },
            )
        }
        if (error.status === 44) {
            log("keychain_read_error", {
                service: serviceName,
                errorType: "not_found",
            })
            return null // item not found
        }
        log("keychain_read_error", {
            service: serviceName,
            errorType: `exit_${error.status ?? "unknown"}`,
        })
        throw new Error(
            `Failed to read Keychain entry "${serviceName}" (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`,
            { cause: err },
        )
    }
}

function listClaudeKeychainRefs(): KeychainRef[] {
    try {
        const dump = execFileSync("/usr/bin/security", ["dump-keychain"], {
            timeout: 5000,
            maxBuffer: 1024 * 1024 * 10, // 10 MB
            encoding: "utf-8",
        })
        const refs = parseKeychainDump(dump)
        if (refs.length === 0) return [{ service: PRIMARY_SERVICE }]
        log("keychain_list", { servicesFound: refs.map(encodeSource) })
        return refs
    } catch (err) {
        log("keychain_list", {
            error: "Failed to list keychain services",
            message: err instanceof Error ? err.message : String(err),
        })
        return [{ service: PRIMARY_SERVICE }]
    }
}

function readCredentialsFileOutcome(): ReadOutcome {
    let raw: string
    try {
        raw = readFileSync(getClaudeCredentialsPath(), "utf-8")
    } catch (err) {
        // A missing file is a definitive "no login here"; anything else
        // (permissions, I/O) leaves us without an answer.
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT"
        log("credentials_file_read", { success: false, missing })
        return missing ? { kind: "no-login" } : { kind: "unreadable" }
    }
    const outcome = parseCredentialsOutcome(raw)
    log("credentials_file_read", { success: outcome.kind === "credentials" })
    return outcome
}

function readCredentialsFile(): ClaudeCredentials | null {
    const outcome = readCredentialsFileOutcome()
    return outcome.kind === "credentials" ? outcome.credentials : null
}

/**
 * Whether Claude Code definitively holds no login: every store we consulted was
 * read successfully and contained none. Storage we could not read (torn write,
 * permission blip, locked Keychain) yields false — it proves nothing, and only
 * proof may drive destructive cleanup.
 */
export function claudeCredentialsAbsent(): boolean {
    const outcomes: ReadOutcome[] = [readCredentialsFileOutcome()]

    if (process.platform === "darwin") {
        try {
            for (const ref of listClaudeKeychainRefs()) {
                const raw = readKeychainService(ref)
                outcomes.push(
                    raw === null
                        ? { kind: "no-login" } // item does not exist
                        : parseCredentialsOutcome(raw),
                )
            }
        } catch {
            return false // locked or denied: no answer
        }
    }

    return outcomes.every((outcome) => outcome.kind === "no-login")
}

export function buildAccountLabels(credsList: ClaudeCredentials[]): string[] {
    const baseLabels = credsList.map((c) => {
        if (c.subscriptionType) {
            const tier =
                c.subscriptionType.charAt(0).toUpperCase() +
                c.subscriptionType.slice(1)
            return `Claude ${tier}`
        }
        return "Claude"
    })

    const counts = new Map<string, number>()
    for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1)

    const seen = new Map<string, number>()
    return baseLabels.map((base) => {
        if ((counts.get(base) ?? 0) <= 1) return base
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        return `${base} ${n}`
    })
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
    if (process.platform !== "darwin") {
        const creds = readCredentialsFile()
        if (!creds) return []
        const [label] = buildAccountLabels([creds])
        return [{ label, source: "file", credentials: creds }]
    }

    const refs = listClaudeKeychainRefs()
    const rawAccounts: Array<{
        source: string
        credentials: ClaudeCredentials
    }> = []

    for (const ref of refs) {
        const raw = readKeychainService(ref)
        if (!raw) continue
        const creds = parseCredentials(raw)
        if (!creds) continue
        rawAccounts.push({ source: encodeSource(ref), credentials: creds })
    }

    // Several items can hold credentials for the same Claude account, one of
    // them stale. Ordering by expiry makes the freshest the default account, so
    // a leftover expired item can no longer shadow a valid login.
    rawAccounts.sort(
        (a, b) => b.credentials.expiresAt - a.credentials.expiresAt,
    )

    if (rawAccounts.length === 0) {
        const creds = readCredentialsFile()
        if (creds) rawAccounts.push({ source: "file", credentials: creds })
    }

    const labels = buildAccountLabels(rawAccounts.map((a) => a.credentials))
    return rawAccounts.map((a, i) => ({
        label: labels[i],
        source: a.source,
        credentials: a.credentials,
    }))
}

export function readAccountCredentials(
    source: string,
): ClaudeCredentials | null {
    if (source === "file") {
        return readCredentialsFile()
    }
    const raw = readKeychainService(decodeSource(source))
    if (!raw) return null
    return parseCredentials(raw)
}
