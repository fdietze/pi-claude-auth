import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { acquireDirLock } from "./dir-lock.ts"

let dir = ""
let target = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-dir-lock-"))
    target = join(dir, "claude-refresh")
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

test("the lock is exclusive and reusable after release", () => {
    const first = acquireDirLock(target, { staleMs: 60_000 })
    assert.ok(first)
    assert.equal(acquireDirLock(target, { staleMs: 60_000 }), null)

    first.release()
    assert.equal(existsSync(`${target}.lock`), false)

    const second = acquireDirLock(target, { staleMs: 60_000 })
    assert.ok(second)
    second.release()
})

test("a stale lock is taken over and its old holder is compromised", () => {
    const abandoned = acquireDirLock(target, { staleMs: 60_000 })
    assert.ok(abandoned)
    // Simulate a holder that stopped refreshing its lock an hour ago.
    const anHourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(`${target}.lock`, anHourAgo, anHourAgo)

    const taken = acquireDirLock(target, { staleMs: 60_000 })
    assert.ok(taken, "a dead holder's lock must be takeable")

    // The old holder must not remove the lock the new owner holds.
    abandoned.release()
    assert.equal(acquireDirLock(target, { staleMs: 60_000 }), null)
    taken.release()
})

test("a live holder's lock stays young and is not taken over", async () => {
    // staleMs 2s means the holder refreshes it every second.
    const held = acquireDirLock(target, { staleMs: 2_000 })
    assert.ok(held)
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    assert.equal(
        acquireDirLock(target, { staleMs: 2_000 }),
        null,
        "a refreshed lock must not look abandoned",
    )
    assert.equal(held.signal.aborted, false)
    held.release()
})

test("losing the lock aborts the holder's signal", async () => {
    const held = acquireDirLock(target, { staleMs: 2_000 })
    assert.ok(held)
    // Another process takes it over: same path, different mtime.
    const stolen = new Date(Date.now() + 1_000)
    utimesSync(`${target}.lock`, stolen, stolen)

    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.equal(held.signal.aborted, true)
    held.release()
    assert.equal(existsSync(`${target}.lock`), true, "not ours to remove")
})
