import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    getActiveCredentials,
    pickUsableAccount,
    initAccounts,
    loadPersistedAccountSource,
    saveAccountSource,
    setActiveAccountSource,
} from "./credentials.ts"
import { readAllClaudeAccounts } from "./keychain.ts"

let dir = ""
let prevEnv: string | undefined
let prevHome: string | undefined

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    prevHome = process.env.HOME
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"))
    process.env.PI_CODING_AGENT_DIR = dir
    // Every path the extension touches is derived from these two env vars, so
    // no test can reach the real ~/.claude or ~/.pi credentials.
    process.env.HOME = dir
})

afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
})

function writeClaudeCredentials(accessToken: string, expiresAt: number): void {
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(
        join(dir, ".claude", ".credentials.json"),
        JSON.stringify({
            claudeAiOauth: { accessToken, refreshToken: "secret", expiresAt },
        }),
        "utf-8",
    )
}

test("getActiveCredentials: picks up an externally rewritten file", (t) => {
    if (process.platform === "darwin") {
        // macOS reads the Keychain, which has no file to rewrite.
        t.skip("file source is not the macOS path")
        return
    }
    const expiresAt = Date.now() + 8 * 3_600_000
    writeClaudeCredentials("first", expiresAt)
    initAccounts(readAllClaudeAccounts())
    setActiveAccountSource("file")
    assert.equal(getActiveCredentials()?.accessToken, "first")

    // The Claude CLI refreshed in the background.
    writeClaudeCredentials("second-token", expiresAt + 1)
    assert.equal(getActiveCredentials()?.accessToken, "second-token")
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})

test("pickUsableAccount: prefers a usable account over the one that failed", () => {
    const accounts = [
        {
            label: "Claude Max",
            source: "svc\u0001old",
            credentials: { accessToken: "a", refreshToken: "r", expiresAt: 1 },
        },
        {
            label: "Claude Max 2",
            source: "svc\u0001new",
            credentials: {
                accessToken: "b",
                refreshToken: "r",
                expiresAt: 10_000,
            },
        },
    ]
    assert.equal(
        pickUsableAccount(accounts, "svc\u0001old", 5_000)?.source,
        "svc\u0001new",
    )
    // Nothing usable elsewhere: the caller must keep the original failure.
    assert.equal(pickUsableAccount(accounts, "svc\u0001old", 20_000), null)
    assert.equal(pickUsableAccount(accounts, "svc\u0001new", 5_000), null)
})
