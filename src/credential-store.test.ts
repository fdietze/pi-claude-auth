import assert from "node:assert/strict"
import { test } from "node:test"
import {
    CLAUDE_UNAVAILABLE_MESSAGE,
    CredentialStore,
    LOGIN_EXPIRED_MESSAGE,
    LoginUnusable,
    MIN_VALIDITY_MS,
    REFRESH_BUSY_MESSAGE,
    type CredentialStoreDeps,
} from "./credential-store.ts"
import { ClaudeCliUnavailable, ClaudeRefreshTimedOut } from "./claude-cli.ts"
import type { ClaudeCredentials } from "./keychain.ts"

const SOURCE = "file"
const NOW = 1_700_000_000_000

function creds(expiresAt: number, accessToken = "access"): ClaudeCredentials {
    return { accessToken, refreshToken: "refresh", expiresAt }
}

const FRESH = creds(NOW + 8 * 3_600_000, "fresh")
const NEAR_EXPIRY = creds(NOW + MIN_VALIDITY_MS - 1_000, "near")
const EXPIRED = creds(NOW - 1_000, "expired")

/**
 * A fake world: an in-memory credential source with a stamp, a `claude` run
 * that finishes only when the test says so, and a frozen clock. Everything the
 * store does to the outside is observable here — no `claude`, no files, no
 * waiting.
 */
function makeWorld(initial: ClaudeCredentials | null) {
    const pending: Array<() => void> = []
    const world = {
        stored: initial,
        stamp: "s0",
        reads: 0,
        refreshRuns: 0,
        now: NOW,
        /** What the delegated `claude` run does to the source when it ends. */
        onRefresh: (): void => {
            world.write(FRESH)
        },
        write(next: ClaudeCredentials | null): void {
            world.stored = next
            world.stamp = `s${Number(world.stamp.slice(1)) + 1}`
        },
        /** Let every running `claude` finish. */
        finishRuns(): void {
            for (const finish of pending.splice(0)) finish()
        },
    }

    const deps: CredentialStoreDeps = {
        readSource: () => {
            world.reads++
            return world.stored
        },
        stampSource: () => world.stamp,
        runClaudeRefresh: () => {
            world.refreshRuns++
            return new Promise<void>((resolve, reject) => {
                pending.push(() => {
                    try {
                        world.onRefresh()
                        resolve()
                    } catch (err) {
                        reject(err)
                    }
                })
            })
        },
        now: () => world.now,
    }

    // The store keeps this exact deps object, so tests can still swap a single
    // behaviour after construction.
    return { world, deps, store: new CredentialStore(deps) }
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Await `promise` while the fake `claude` completes. */
async function withRunsFinished<T>(
    world: ReturnType<typeof makeWorld>["world"],
    promise: Promise<T>,
): Promise<T> {
    await settle()
    world.finishRuns()
    return promise
}

test("read: re-reads only when the source stamp changed", () => {
    const { world, store } = makeWorld(FRESH)

    assert.equal(store.read(SOURCE)?.accessToken, "fresh")
    assert.equal(world.reads, 1)

    // Unchanged source: served from memory.
    store.read(SOURCE)
    store.read(SOURCE)
    assert.equal(world.reads, 1)

    // The Claude CLI rewrote the credentials file.
    world.write(creds(NOW + 3_600_000, "rotated"))
    assert.equal(store.read(SOURCE)?.accessToken, "rotated")
    assert.equal(world.reads, 2)
})

test("read: re-reads every time when the source has no stamp", () => {
    const { world, deps, store } = makeWorld(FRESH)
    deps.stampSource = () => null // keychain file not known: cannot validate

    store.read(SOURCE)
    store.read(SOURCE)
    assert.equal(world.reads, 2)

    // Another process rotated the token; a stale copy would be revoked.
    world.write(creds(NOW + 3_600_000, "rotated"))
    assert.equal(store.read(SOURCE)?.accessToken, "rotated")
})

test("ensureFresh: fresh credentials never spawn a refresh", async () => {
    const { world, store } = makeWorld(FRESH)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: usable credentials near expiry start a run and return at once", async () => {
    const { world, store } = makeWorld(NEAR_EXPIRY)
    // Resolves although the run has not finished: pi holds its auth.json lock.
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "near")
    assert.equal(world.refreshRuns, 1)

    // Requests during the run join it instead of spawning another.
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "near")
    assert.equal(world.refreshRuns, 1)

    // The next request after the run sees what it wrote.
    world.finishRuns()
    await settle()
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: expired credentials wait for the run and return its result", async () => {
    const { world, store } = makeWorld(EXPIRED)
    const result = await withRunsFinished(world, store.ensureFresh(SOURCE))
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: concurrent callers share one run", async () => {
    const { world, store } = makeWorld(EXPIRED)
    const results = Promise.all([
        store.ensureFresh(SOURCE),
        store.ensureFresh(SOURCE),
        store.ensureFresh(SOURCE),
    ])
    const tokens = (await withRunsFinished(world, results)).map(
        (c) => c.accessToken,
    )
    assert.deepEqual(tokens, ["fresh", "fresh", "fresh"])
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: the source refreshed by someone else spawns nothing", async () => {
    const { world, store } = makeWorld(EXPIRED)
    store.read(SOURCE)
    world.write(FRESH)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: abort while expired reports a running refresh; the run continues", async () => {
    const { world, store } = makeWorld(EXPIRED)
    const caller = new AbortController()
    const result = store.ensureFresh(SOURCE, caller.signal)
    await settle()
    caller.abort(new Error("timed out"))
    await assert.rejects(result, { message: REFRESH_BUSY_MESSAGE })

    // The run was not stopped; its result serves the next request.
    world.finishRuns()
    await settle()
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: an already aborted caller starts nothing", async () => {
    const { world, store } = makeWorld(EXPIRED)
    const caller = new AbortController()
    caller.abort()
    await assert.rejects(store.ensureFresh(SOURCE, caller.signal))
    assert.equal(world.refreshRuns, 0)
})

test("a dead login is reported and not retried until its state changes", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {} // the CLI cannot refresh this login

    assert.equal(store.loginProblem(SOURCE), null)
    await assert.rejects(
        withRunsFinished(world, store.ensureFresh(SOURCE)),
        (err) => err instanceof LoginUnusable,
    )
    assert.equal(store.loginProblem(SOURCE), LOGIN_EXPIRED_MESSAGE)

    // Same state: no second run.
    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)

    // A new login rewrites the source: the problem is gone.
    world.write(FRESH)
    assert.equal(store.loginProblem(SOURCE), null)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")

    // A rewrite that is still expired is a new state and earns one more run.
    world.write(creds(NOW - 500, "still-expired"))
    await assert.rejects(withRunsFinished(world, store.ensureFresh(SOURCE)))
    assert.equal(world.refreshRuns, 2)
})

test("an unrefreshed usable token is used and retried only once expired", async () => {
    const { world, store } = makeWorld(NEAR_EXPIRY)
    world.onRefresh = () => {}

    await store.ensureFresh(SOURCE)
    world.finishRuns()
    await settle()
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "near")
    assert.equal(world.refreshRuns, 1)
    assert.equal(store.loginProblem(SOURCE), null)

    // Crossing expiry changes the state: worth asking again.
    world.now = NEAR_EXPIRY.expiresAt + 1
    const retried = store.ensureFresh(SOURCE)
    world.onRefresh = () => world.write(FRESH)
    assert.equal((await withRunsFinished(world, retried)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 2)
})

test("a timeout is transient: reported as such, not remembered", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {
        throw new ClaudeRefreshTimedOut("timed out")
    }
    await assert.rejects(
        withRunsFinished(world, store.ensureFresh(SOURCE)),
        ClaudeRefreshTimedOut,
    )
    assert.equal(store.loginProblem(SOURCE), null)
    await assert.rejects(withRunsFinished(world, store.ensureFresh(SOURCE)))
    assert.equal(world.refreshRuns, 2)
})

test("a timed-out run that still rotated is used", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {
        world.write(FRESH)
        throw new ClaudeRefreshTimedOut("timed out after writing")
    }
    const result = await withRunsFinished(world, store.ensureFresh(SOURCE))
    assert.equal(result.accessToken, "fresh")
})

test("an unrunnable claude CLI is reported as such and not remembered", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {
        throw new ClaudeCliUnavailable("spawn claude ENOENT")
    }
    await assert.rejects(withRunsFinished(world, store.ensureFresh(SOURCE)), {
        message: CLAUDE_UNAVAILABLE_MESSAGE,
    })
    assert.equal(store.loginProblem(SOURCE), null)
})

test("a failing re-read after a run nobody waits for is contained", async () => {
    const { world, deps, store } = makeWorld(NEAR_EXPIRY)
    await store.ensureFresh(SOURCE)
    deps.readSource = () => {
        throw new Error("keychain locked")
    }
    // Would be an unhandled rejection (and fail this test) if not contained.
    world.finishRuns()
    await settle()
    await settle()
})
