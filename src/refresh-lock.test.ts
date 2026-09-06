import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { acquireRefreshLock } from "./refresh-lock.ts"

let dir = ""
let prevEnv: string | undefined

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-refresh-lock-"))
    process.env.PI_CODING_AGENT_DIR = dir
})

afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
})

test("the refresh lock is exclusive and reusable after release", async () => {
    const first = await acquireRefreshLock()
    assert.ok(first, "a free lock must be acquirable")
    assert.equal(await acquireRefreshLock(), null, "held lock must be refused")

    await first.release()
    const second = await acquireRefreshLock()
    assert.ok(second, "a released lock must be acquirable again")
    await second.release()
})
