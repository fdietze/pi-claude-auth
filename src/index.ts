import type {
    ExtensionAPI,
    ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import {
    getActiveCredentials,
    getLoginProblem,
    initAccounts,
    loadPersistedAccountSource,
    refreshAccountsList,
    refreshActiveCredentials,
    saveAccountSource,
    setActiveAccountSource,
    syncAuthJson,
    type ClaudeCredentials,
} from "./credentials.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import { buildUserAgent } from "./signing.ts"
import { injectBillingHeader } from "./transforms.ts"

export {
    getActiveCredentials,
    syncAuthJson,
    refreshAccountsList,
    type ClaudeCredentials,
} from "./credentials.ts"
export { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"

// Derive the OAuth types from the official ProviderConfig so the extension
// stays fully typed without importing @earendil-works/pi-ai directly.
type OAuthConfig = NonNullable<ProviderConfig["oauth"]>
type OAuthCreds = Awaited<ReturnType<OAuthConfig["refreshToken"]>>
type LoginCallbacks = Parameters<OAuthConfig["login"]>[0]

const PROVIDER_ID = "anthropic"
const PROVIDER_LABEL = "Claude Code (subscription)"

function toOAuthCreds(creds: ClaudeCredentials): OAuthCreds {
    return {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
}

/**
 * pi-claude-auth extension.
 *
 * Reads your existing Claude Code OAuth credentials (macOS Keychain or
 * `~/.claude/.credentials.json`) and makes pi authenticate as Claude Code with
 * no separate login:
 *
 * - Seeds the credentials into pi's auth.json. A stored credential outranks
 *   ANTHROPIC_API_KEY in pi, so this is all it takes to authenticate.
 * - Overrides the `anthropic` provider's OAuth lifecycle: refresh is delegated
 *   to the Claude CLI, the only writer of the credentials. Multiple accounts
 *   are selectable via `/login`.
 * - Overrides the user-agent to the full Claude Code form and injects the
 *   Claude Code billing header, so requests bill against the Claude Pro/Max
 *   subscription plan rather than pay-as-you-go API credits or extra usage.
 *
 * pi's built-in Anthropic provider supplies the remaining Claude Code fidelity
 * (identity prompt, beta flags, tool naming) for OAuth tokens.
 */
const extension = async (pi: ExtensionAPI): Promise<void> => {
    initLogger()

    let accounts: ClaudeAccount[] = []
    try {
        accounts = readAllClaudeAccounts()
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log("extension_init_error", { error })
        console.warn(
            "pi-claude-auth: Failed to read Claude Code credentials:",
            error,
        )
        return
    }

    initAccounts(accounts)

    if (accounts.length === 0) {
        log("extension_init_no_accounts", { reason: "no credentials found" })
        console.warn(
            "pi-claude-auth: No Claude Code credentials found. Run `claude` to authenticate first.",
        )
        return
    }

    const persistedSource = loadPersistedAccountSource()
    const defaultAccount =
        (persistedSource &&
            accounts.find((a) => a.source === persistedSource)) ||
        accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("extension_init", {
        accountCount: accounts.length,
        sources: accounts.map((a) => a.source),
        activeSource: defaultAccount.source,
    })

    // Seed auth.json so pi uses the Claude Code credentials with zero login.
    // Expired credentials are seeded too: pi then calls refreshToken below,
    // which delegates the refresh to the Claude CLI.
    const initialCreds = getActiveCredentials()
    if (initialCreds) syncAuthJson(initialCreds)

    const oauth: OAuthConfig = {
        name: PROVIDER_LABEL,

        async login(callbacks: LoginCallbacks): Promise<OAuthCreds> {
            const latestAccounts = refreshAccountsList()
            if (latestAccounts.length === 0) {
                throw new Error(
                    "No Claude Code credentials found. Run `claude` to authenticate first.",
                )
            }

            const currentSource =
                loadPersistedAccountSource() ?? defaultAccount.source
            let chosen =
                latestAccounts.find((a) => a.source === currentSource) ??
                latestAccounts[0]

            // Offer an account picker when multiple Claude Code accounts exist.
            if (latestAccounts.length > 1 && callbacks.onSelect) {
                const picked = await callbacks.onSelect({
                    message: "Select which Claude Code account to use:",
                    options: latestAccounts.map((a) => ({
                        id: a.source,
                        label:
                            a.source === currentSource
                                ? `${a.label} (active)`
                                : a.label,
                    })),
                })
                if (picked) {
                    chosen =
                        latestAccounts.find((a) => a.source === picked) ??
                        chosen
                }
            }

            setActiveAccountSource(chosen.source)
            saveAccountSource(chosen.source)

            const creds = getActiveCredentials() ?? chosen.credentials
            syncAuthJson(creds)
            log("login", { source: chosen.source, label: chosen.label })
            return toOAuthCreds(creds)
        },

        // pi calls this once the stored token is within five minutes of expiry,
        // holding its auth.json lock. Throwing surfaces the message to the user
        // ("OAuth refresh failed for anthropic: <message>"); pi persists what
        // we return, so there is nothing to write back here.
        async refreshToken(): Promise<OAuthCreds> {
            return toOAuthCreds(await refreshActiveCredentials())
        },

        getApiKey(credentials: OAuthCreds): string {
            // Read-only: pi has already refreshed if the token was near expiry.
            // pi surfaces a throw here as "OAuth auth derivation failed for
            // anthropic: <message>", which beats handing out a token we know is
            // dead and letting the user decode an opaque 401.
            const problem = getLoginProblem()
            if (problem) throw new Error(problem)
            return getActiveCredentials()?.accessToken ?? credentials.access
        },
    }

    // Override the user-agent to the full Claude Code form
    // (`claude-cli/<version> (external, <entrypoint>)`). pi sends a bare
    // `claude-cli/<version>`, which Anthropic's plan-billing validation does
    // not accept — without this the request bills against extra usage instead
    // of the subscription plan.
    pi.registerProvider(PROVIDER_ID, {
        oauth,
        headers: { "user-agent": buildUserAgent() },
    })

    // Tell the user once per session when the Claude Code login is dead. The
    // check is a stat plus a small file read: no subprocess, no network, no
    // timer. Nothing retries until Claude Code writes new credentials.
    pi.on("session_start", async (_event, ctx) => {
        const problem = getLoginProblem()
        if (problem) ctx.ui.notify(`pi-claude-auth: ${problem}`, "warning")
    })

    // Inject the Claude Code billing header so requests bill against the
    // Claude Pro/Max subscription rather than pay-as-you-go API credits.
    // pi's built-in Anthropic provider supplies the identity, betas, and
    // user-agent for OAuth tokens but not this header.
    pi.on("before_provider_request", (event) => {
        try {
            const updated = injectBillingHeader(event.payload)
            if (updated) {
                log("billing_header_injected", {})
                return updated
            }
        } catch (err) {
            log("billing_header_error", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
        return undefined
    })

    log("provider_registered", { provider: PROVIDER_ID })
}

export const ClaudeAuthExtension = extension
export default extension
