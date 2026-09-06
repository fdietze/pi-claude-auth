import assert from "node:assert/strict"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { tryAcquireFileLock } from "./file-lock.ts"

let dir = ""
let lockPath = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-lock-"))
    lockPath = join(dir, "nested", "claude-refresh.lock")
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

test("a second acquire fails while the lock is held", () => {
    const first = tryAcquireFileLock(lockPath, { staleMs: 60_000 })
    assert.ok(first)
    assert.equal(tryAcquireFileLock(lockPath, { staleMs: 60_000 }), null)
    first.release()
    const third = tryAcquireFileLock(lockPath, { staleMs: 60_000 })
    assert.ok(third)
    third.release()
})

test("a stale lock is taken over", () => {
    const abandoned = tryAcquireFileLock(lockPath, { staleMs: 60_000 })
    assert.ok(abandoned)
    // Simulate a holder that died an hour ago.
    const anHourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(lockPath, anHourAgo, anHourAgo)

    const taken = tryAcquireFileLock(lockPath, { staleMs: 60_000 })
    assert.ok(taken)

    // The stale holder must not delete the lock the new owner holds.
    abandoned.release()
    assert.equal(tryAcquireFileLock(lockPath, { staleMs: 60_000 }), null)
    taken.release()
})

test("release tolerates a lock file that vanished", () => {
    const lock = tryAcquireFileLock(lockPath, { staleMs: 60_000 })
    assert.ok(lock)
    rmSync(lockPath)
    lock.release()
})

test("a lock file with unexpected content is respected until stale", () => {
    const other = join(dir, "other.lock")
    writeFileSync(other, "someone else")
    assert.equal(tryAcquireFileLock(other, { staleMs: 60_000 }), null)
})
