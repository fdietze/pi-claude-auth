import assert from "node:assert/strict"
import { test } from "node:test"
import {
    CredentialStore,
    LOGIN_EXPIRED_MESSAGE,
    MIN_VALIDITY_MS,
    REFRESH_BUSY_MESSAGE,
    type CredentialStoreDeps,
} from "./credential-store.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import type { FutileRefresh } from "./futile-refresh.ts"

const SOURCE = "file"
const NOW = 1_700_000_000_000

function creds(expiresAt: number, accessToken = "access"): ClaudeCredentials {
    return { accessToken, refreshToken: "refresh", expiresAt }
}

const FRESH = creds(NOW + 8 * 3_600_000, "fresh")
const EXPIRED = creds(NOW - 1_000, "expired")

/**
 * A fake world: an in-memory credential source with a stamp, a lock that can be
 * held by an imaginary other process, and an instant clock. Everything the
 * store does to the outside is observable here — no `claude`, no files, no
 * waiting.
 */
function makeWorld(initial: ClaudeCredentials | null) {
    const world = {
        stored: initial,
        stamp: "s0",
        reads: 0,
        refreshRuns: 0,
        lockHeldByOther: false,
        lockedByUs: false,
        marker: null as FutileRefresh | null,
        slept: 0,
        now: NOW,
        /** What the delegated `claude` run does to the source. */
        onRefresh: (): void => {
            world.write(FRESH)
        },
        write(next: ClaudeCredentials | null): void {
            world.stored = next
            world.stamp = `s${Number(world.stamp.slice(1)) + 1}`
        },
    }

    const deps: CredentialStoreDeps = {
        readSource: () => {
            world.reads++
            return world.stored
        },
        stampSource: () => world.stamp,
        acquireRefreshLock: () => {
            if (world.lockHeldByOther) return null
            world.lockedByUs = true
            return {
                release: () => {
                    world.lockedByUs = false
                },
            }
        },
        runClaudeRefresh: async () => {
            world.refreshRuns++
            world.onRefresh()
        },
        readFutileRefresh: () => world.marker,
        writeFutileRefresh: (marker) => {
            world.marker = marker
        },
        now: () => world.now,
        sleep: async (ms) => {
            world.slept += ms
            world.now += ms
        },
    }

    // The store keeps this exact deps object, so tests can still swap a single
    // behaviour (a slow lock holder, a failing CLI) after construction.
    return { world, deps, store: new CredentialStore(deps) }
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

test("read: keeps the in-memory copy for sources without a stamp", () => {
    const { world, deps, store } = makeWorld(FRESH)
    deps.stampSource = () => null // macOS Keychain: no cheap change check

    store.read(SOURCE)
    store.read(SOURCE)
    assert.equal(world.reads, 1)
})

test("ensureFresh: valid credentials never spawn a refresh", async () => {
    const { world, store } = makeWorld(FRESH)
    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: credentials inside the validity window are refreshed", async () => {
    const { world, store } = makeWorld(creds(NOW + MIN_VALIDITY_MS - 1_000))
    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: expired credentials delegate exactly one refresh", async () => {
    const { world, store } = makeWorld(EXPIRED)

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.lockedByUs, false, "lock must be released")
})

test("ensureFresh: no second refresh when the lock holder already refreshed", async () => {
    const { world, store } = makeWorld(EXPIRED)
    // First read caches the expired credentials, then another process refreshes
    // and releases the lock before we take it.
    store.read(SOURCE)
    world.write(FRESH)

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: a waiter uses the other process's result without spawning", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true
    // The holder's `claude` writes the refreshed credentials while we wait.
    const sleep = deps.sleep
    let ticks = 0
    deps.sleep = async (ms) => {
        await sleep(ms)
        if (++ticks === 3) world.write(FRESH)
    }

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
    assert.ok(world.slept > 0, "waiter polled the source")
})

test("ensureFresh: a permanently busy lock fails as transient, without spawning", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: REFRESH_BUSY_MESSAGE,
    })
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: still-expired after the refresh reports an expired login", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {} // `claude` ran but did not log in

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.lockedByUs, false, "lock must be released")
})

test("ensureFresh: a failing claude run still uses what it wrote", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        world.refreshRuns++
        world.write(FRESH)
        throw new Error("claude exited with 1")
    }

    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
})

test("a failed login is remembered and retried only after the source changes", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {} // `claude` cannot log in anymore

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.marker?.source, SOURCE)

    // Same source state: no second `claude`, no waiting, just the message.
    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(store.loginProblem(SOURCE), LOGIN_EXPIRED_MESSAGE)

    // The user ran `claude` and logged in: the source changed, so retry.
    world.onRefresh = () => world.write(FRESH)
    world.write(creds(NOW - 500, "still-expired-but-new"))
    assert.equal(store.loginProblem(SOURCE), null)

    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 2)
    assert.equal(world.marker, null, "successful refresh clears the record")
})

test("a marker from another account does not block this one", () => {
    const { world, store } = makeWorld(EXPIRED)
    world.marker = { source: "Claude Code-credentials", state: world.stamp }
    assert.equal(store.loginProblem(SOURCE), null)
})

test("credentials short of the safety margin are used, not declared dead", async () => {
    // The CLI refuses to refresh a token it still considers good.
    const { world, store } = makeWorld(creds(NOW + 30_000, "almost-expired"))
    world.onRefresh = () => {}

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "almost-expired")
    assert.equal(world.refreshRuns, 1)
    assert.equal(store.loginProblem(SOURCE), null, "not a login problem yet")

    // A second request in the same window must not run the CLI again.
    await store.ensureFresh(SOURCE)
    assert.equal(world.refreshRuns, 1)

    // Once the token is actually expired, the CLI is worth another try.
    world.now = NOW + 60_000
    world.onRefresh = () => world.write(FRESH)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 2)
})

test("a transient lock timeout is not remembered as a failed login", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: REFRESH_BUSY_MESSAGE,
    })
    assert.equal(world.marker, null)
})
