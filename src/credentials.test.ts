import assert from "node:assert/strict"
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    getActiveCredentials,
    initAccounts,
    loadPersistedAccountSource,
    saveAccountSource,
    setActiveAccountSource,
    syncAuthJson,
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

test("syncAuthJson: writes a pi oauth entry under anthropic", () => {
    syncAuthJson({
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: 12345,
    })
    const raw = readFileSync(join(dir, "auth.json"), "utf-8")
    const parsed = JSON.parse(raw) as {
        anthropic: {
            type: string
            access: string
            refresh: string
            expires: number
        }
    }
    assert.deepEqual(parsed.anthropic, {
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: 12345,
    })
})

test("syncAuthJson: preserves other providers in auth.json", () => {
    const authPath = join(dir, "auth.json")
    // Seed an unrelated provider, then sync anthropic on top of it.
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    syncAuthJson({ accessToken: "a2", refreshToken: "r2", expiresAt: 2 })
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { type: string; key: string }
    }
    assert.equal(parsed.anthropic.access, "a2")
    assert.deepEqual(parsed.openai, { type: "api_key", key: "sk-test" })
})

test("syncAuthJson: skips the write when auth.json is malformed", () => {
    const authPath = join(dir, "auth.json")
    // Simulate a torn read: another process is mid-write.
    const torn = '{ "openai-codex": { "type": "oauth", "acc'
    writeFileSync(authPath, torn, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    // File must be left untouched, not rebuilt from scratch.
    assert.equal(readFileSync(authPath, "utf-8"), torn)
})

test("syncAuthJson: no-op when the anthropic entry is already in sync", () => {
    const authPath = join(dir, "auth.json")
    const creds = { accessToken: "acc", refreshToken: "ref", expiresAt: 5 }
    syncAuthJson(creds)
    // Something else edits an unrelated provider between syncs. Written
    // compact, so any rewrite (which pretty-prints) changes the bytes.
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
        string,
        unknown
    >
    parsed["openai-codex"] = { type: "oauth", access: "x" }
    const compact = JSON.stringify(parsed)
    writeFileSync(authPath, compact, "utf-8")
    // A repeat sync with identical creds must not rewrite the file.
    syncAuthJson(creds)
    assert.equal(readFileSync(authPath, "utf-8"), compact)
})

test("syncAuthJson: leaves no temp files behind", () => {
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})
