import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    removeSeededCredential,
    seedAnthropicCredential,
    toPiOAuthCredential,
} from "./auth-json.ts"

let dir = ""
let authPath = ""
let prevEnv: string | undefined

const CREDS = {
    accessToken: "acc",
    refreshToken: "single-use-refresh-token",
    expiresAt: 12345,
}

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-authjson-"))
    process.env.PI_CODING_AGENT_DIR = dir
    authPath = join(dir, "auth.json")
})

afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
})

test("toPiOAuthCredential: never exposes the real refresh token", () => {
    assert.deepEqual(toPiOAuthCredential(CREDS), {
        type: "oauth",
        access: "acc",
        refresh: "",
        expires: 12345,
    })
})

test("seedAnthropicCredential: writes the anthropic entry without the refresh token", async () => {
    await seedAnthropicCredential(CREDS)
    const raw = readFileSync(authPath, "utf-8")
    assert.ok(
        !raw.includes(CREDS.refreshToken),
        "auth.json must never contain the Claude refresh token",
    )
    assert.deepEqual(JSON.parse(raw).anthropic, {
        type: "oauth",
        access: "acc",
        refresh: "",
        expires: 12345,
    })
})

test("seedAnthropicCredential: preserves other providers", async () => {
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    await seedAnthropicCredential(CREDS)
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(parsed.anthropic.access, "acc")
    assert.deepEqual(parsed.openai, { type: "api_key", key: "sk-test" })
})

test("seedAnthropicCredential: no-op when the entry is already in sync", async () => {
    await seedAnthropicCredential(CREDS)
    // Compact rewrite: any pointless rewrite (which pretty-prints) shows up.
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
    parsed["openai-codex"] = { type: "oauth", access: "x" }
    const compact = JSON.stringify(parsed)
    writeFileSync(authPath, compact, "utf-8")

    await seedAnthropicCredential(CREDS)
    assert.equal(readFileSync(authPath, "utf-8"), compact)
})

test("seedAnthropicCredential: leaves no lock behind", async () => {
    await seedAnthropicCredential(CREDS)
    assert.equal(
        await seedAnthropicCredential(CREDS).then(() => "ok"),
        "ok",
        "a leaked lock would block the next write",
    )
})

test("seedAnthropicCredential: refuses to rebuild a corrupt auth.json", async () => {
    const corrupt = '{ "openai-codex": { "type": "oauth", "acc'
    writeFileSync(authPath, corrupt, "utf-8")
    await assert.rejects(seedAnthropicCredential(CREDS))
    assert.equal(readFileSync(authPath, "utf-8"), corrupt)
})

test("removeSeededCredential: drops our entry but keeps other providers", async () => {
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    await seedAnthropicCredential(CREDS)
    await removeSeededCredential()

    const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal("anthropic" in parsed, false)
    assert.deepEqual(parsed.openai, { type: "api_key", key: "sk-test" })
})

test("removeSeededCredential: never touches a credential we did not write", async () => {
    const foreign = {
        anthropic: {
            type: "oauth",
            access: "a",
            refresh: "someone-elses-refresh-token",
            expires: 1,
        },
    }
    writeFileSync(authPath, JSON.stringify(foreign), "utf-8")
    await removeSeededCredential()
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf-8")), foreign)
})

test("removeSeededCredential: no-op without an auth.json", async () => {
    await removeSeededCredential()
})
