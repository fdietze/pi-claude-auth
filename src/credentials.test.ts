import assert from "node:assert/strict"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    getActiveCredentials,
    getAccounts,
    refreshActiveCredentials,
    pickUsableAccount,
    initAccounts,
    loadPersistedAccountSource,
    saveAccountSource,
    setActiveAccountSource,
} from "./credentials.ts"
import { REFRESH_BUSY_MESSAGE } from "./credential-store.ts"
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

test("canceled caller gets a busy error; the run ends without auth write or account fallback", async (t) => {
    if (process.platform === "darwin" || process.platform === "win32") {
        t.skip("isolated file-source executable stub is Unix non-macOS")
        return
    }
    const oldPath = process.env.PATH
    const bin = join(dir, "bin")
    mkdirSync(bin)
    // The only executable available to the runner is this token-free stub.
    writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}
        setTimeout(() => {
            require("node:fs").writeFileSync(${JSON.stringify(join(dir, "claude-done"))}, "");
            process.exit(0);
        }, 150);
    `,
        { mode: 0o700 },
    )
    process.env.PATH = bin
    try {
        writeClaudeCredentials("expired-fake", Date.now() - 1_000)
        const accounts = readAllClaudeAccounts()
        accounts.push({
            source: "fake-alternative",
            label: "other",
            credentials: {
                accessToken: "other-fake",
                refreshToken: "fake",
                expiresAt: Date.now() + 3_600_000,
            },
        })
        initAccounts(accounts)
        setActiveAccountSource("file")
        saveAccountSource("file")
        const auth = join(dir, "auth.json")
        writeFileSync(auth, '{"untouched":"pi persistence only"}')
        const bytes = readFileSync(auth)
        const caller = new AbortController()
        const result = refreshActiveCredentials(caller.signal)
        caller.abort(new Error("canceled caller"))
        await assert.rejects(result, {
            message: REFRESH_BUSY_MESSAGE,
        })
        // Wait for the stub's completion, not real credential activity.
        const done = join(dir, "claude-done")
        const deadline = Date.now() + 5_000
        while (!existsSync(done) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.equal(existsSync(done), true, "the canceled run kept going")
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.deepEqual(readFileSync(auth), bytes)
        assert.deepEqual(
            getAccounts(),
            accounts,
            "no fallback account rediscovery",
        )
        assert.equal(getActiveCredentials()?.accessToken, "expired-fake")
        assert.equal(loadPersistedAccountSource(), "file")
    } finally {
        if (oldPath === undefined) delete process.env.PATH
        else process.env.PATH = oldPath
    }
})
