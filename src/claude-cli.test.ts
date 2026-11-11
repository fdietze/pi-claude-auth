import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
    buildRefreshEnv,
    ClaudeCliUnavailable,
    ClaudeRefreshTimedOut,
    waitForClaudeRefresh,
    parseClaudeVersion,
    readClaudeCliVersion,
} from "./claude-cli.ts"

test("buildRefreshEnv: drops auth sources that outrank the OAuth login", () => {
    const env = buildRefreshEnv({
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "token",
        PATH: "/usr/bin",
    })

    // Present, the CLI would answer via the API key and never refresh the
    // OAuth token — a run that succeeds and changes nothing.
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(env.PATH, "/usr/bin")
})

test("buildRefreshEnv: forces TERM=dumb", () => {
    assert.equal(buildRefreshEnv({ TERM: "xterm-256color" }).TERM, "dumb")
})

test("buildRefreshEnv: leaves the caller's environment untouched", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-secret", TERM: "xterm" }
    buildRefreshEnv(base)
    assert.equal(base.ANTHROPIC_API_KEY, "sk-ant-secret")
    assert.equal(base.TERM, "xterm")
})

// Fake processes exercise the runner without running Claude or touching tokens.

/** A child without a pid, so stop signals go through child.kill. */
function fakeChild() {
    const child = new EventEmitter() as ChildProcess
    const signals: string[] = []
    child.kill = (signal) => {
        signals.push(String(signal))
        return true
    }
    return { child, signals }
}

test("waitForClaudeRefresh: exit 0 resolves, other exits reject", async () => {
    const ok = fakeChild()
    const done = waitForClaudeRefresh(ok.child)
    ok.child.emit("close", 0, null)
    await done

    const failed = fakeChild()
    const rejected = waitForClaudeRefresh(failed.child)
    failed.child.emit("close", 1, null)
    await assert.rejects(rejected, /claude exited with 1/)
})

test("waitForClaudeRefresh: a CLI that cannot start is unavailable", async () => {
    const { child } = fakeChild()
    const result = waitForClaudeRefresh(child)
    child.emit("error", new Error("spawn claude ENOENT"))
    await assert.rejects(result, ClaudeCliUnavailable)
})

test("waitForClaudeRefresh: timeout sends SIGTERM, then SIGKILL after the grace", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { child, signals } = fakeChild()
    const result = waitForClaudeRefresh(child, 1_000)
    const rejected = assert.rejects(result, ClaudeRefreshTimedOut)

    t.mock.timers.tick(1_000)
    assert.deepEqual(signals, ["SIGTERM"])
    t.mock.timers.tick(4_999)
    assert.deepEqual(signals, ["SIGTERM"])
    t.mock.timers.tick(1)
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])

    child.emit("close", null, "SIGKILL")
    await rejected
})

test("waitForClaudeRefresh: exiting within the grace avoids SIGKILL", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { child, signals } = fakeChild()
    const result = waitForClaudeRefresh(child, 1_000)
    const rejected = assert.rejects(result, ClaudeRefreshTimedOut)
    t.mock.timers.tick(1_000)
    child.emit("close", 0, null)
    await rejected
    t.mock.timers.tick(10_000)
    assert.deepEqual(signals, ["SIGTERM"])
})

test("parseClaudeVersion: takes the leading semver", () => {
    assert.equal(parseClaudeVersion("2.1.299 (Claude Code)\n"), "2.1.299")
    assert.equal(parseClaudeVersion("2.1.299"), "2.1.299")
})

test("parseClaudeVersion: rejects anything else", () => {
    assert.equal(parseClaudeVersion(""), null)
    assert.equal(parseClaudeVersion("error: nope"), null)
    assert.equal(parseClaudeVersion("2.1.299-evil\r\nx-injected: 1"), null)
})

// A fake `claude` on PATH: no real CLI, no real credentials.
async function withFakeClaude<T>(
    script: string | null,
    run: () => Promise<T>,
): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"))
    const prevPath = process.env.PATH
    if (script !== null) {
        const bin = join(dir, "claude")
        writeFileSync(bin, `#!/bin/sh\n${script}\n`)
        chmodSync(bin, 0o755)
    }
    process.env.PATH = dir
    try {
        return await run()
    } finally {
        process.env.PATH = prevPath
        rmSync(dir, { recursive: true, force: true })
    }
}

test("readClaudeCliVersion: reads stdout, ignores a stderr banner", async () => {
    const version = await withFakeClaude(
        'echo banner >&2; echo "4.5.6 (Claude Code)"',
        readClaudeCliVersion,
    )
    assert.equal(version, "4.5.6")
})

test("readClaudeCliVersion: null when the CLI is missing or fails", async () => {
    assert.equal(await withFakeClaude(null, readClaudeCliVersion), null)
    assert.equal(await withFakeClaude("exit 1", readClaudeCliVersion), null)
})
