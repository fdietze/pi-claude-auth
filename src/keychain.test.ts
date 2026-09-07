import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
    buildAccountLabels,
    claudeCredentialsAbsent,
    decodeSource,
    encodeSource,
    parseKeychainDump,
} from "./keychain.ts"

test("buildAccountLabels: single account uses bare tier label", () => {
    const labels = buildAccountLabels([
        {
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
            subscriptionType: "max",
        },
    ])
    assert.deepEqual(labels, ["Claude Max"])
})

test("buildAccountLabels: missing subscriptionType falls back to Claude", () => {
    const labels = buildAccountLabels([
        { accessToken: "a", refreshToken: "r", expiresAt: 0 },
    ])
    assert.deepEqual(labels, ["Claude"])
})

test("buildAccountLabels: duplicate tiers get numeric suffixes", () => {
    const labels = buildAccountLabels([
        {
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
            subscriptionType: "pro",
        },
        {
            accessToken: "b",
            refreshToken: "s",
            expiresAt: 0,
            subscriptionType: "pro",
        },
    ])
    assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2"])
})

// --- Multi-account / same-service handling -------------------------------
//
// A real dump-keychain excerpt from a machine where Claude Code had written
// credentials under two different account names. Reading such a service
// without -a returns an arbitrary one of the two, which is how an expired
// credential ends up shadowing a valid login.
const DUMP_TWO_ACCOUNTS_ONE_SERVICE = `keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="default"
    "svce"<blob>="Claude Code-credentials"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Claude Code-credentials"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Claude Code-credentials-b9463664"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Some Other Service"
`

test("parseKeychainDump: keeps both accounts sharing one service", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    const primary = refs.filter((r) => r.service === "Claude Code-credentials")
    assert.equal(primary.length, 2)
    assert.deepEqual(primary.map((r) => r.account).sort(), ["alice", "default"])
})

test("parseKeychainDump: pairs each account with its own service", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    const suffixed = refs.find((r) => r.service.endsWith("b9463664"))
    assert.ok(suffixed)
    assert.equal(suffixed.account, "alice")
})

test("parseKeychainDump: ignores unrelated services", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    assert.equal(
        refs.some((r) => r.service === "Some Other Service"),
        false,
    )
})

test("parseKeychainDump: orders the primary service first", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    assert.deepEqual(
        refs.slice(0, 2).map((r) => r.service),
        ["Claude Code-credentials", "Claude Code-credentials"],
    )
})

test("parseKeychainDump: returns nothing for an empty dump", () => {
    assert.deepEqual(parseKeychainDump(""), [])
})

test("encodeSource/decodeSource: round-trips a service+account pair", () => {
    const ref = { service: "Claude Code-credentials", account: "alice" }
    assert.deepEqual(decodeSource(encodeSource(ref)), ref)
})

test("decodeSource: a legacy service-only source stays account-less", () => {
    assert.deepEqual(decodeSource("Claude Code-credentials"), {
        service: "Claude Code-credentials",
    })
})

test("encodeSource: distinguishes accounts under the same service", () => {
    const a = encodeSource({
        service: "Claude Code-credentials",
        account: "default",
    })
    const b = encodeSource({
        service: "Claude Code-credentials",
        account: "alice",
    })
    assert.notEqual(a, b)
})

// --- Definitive absence vs unreadable ------------------------------------

const prevHome = process.env.HOME
let homeDir = ""

afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (homeDir) rmSync(homeDir, { recursive: true, force: true })
    homeDir = ""
})

test("claudeCredentialsAbsent: a readable file without a login is absence", (t) => {
    if (process.platform === "darwin") {
        t.skip("macOS resolves absence through the Keychain")
        return
    }
    homeDir = mkdtempSync(join(tmpdir(), "pi-claude-auth-home-"))
    process.env.HOME = homeDir
    mkdirSync(join(homeDir, ".claude"), { recursive: true })
    // Logging out of Claude Code leaves the file behind without its OAuth
    // section. That is proof of "no login", not an unknown.
    writeFileSync(
        join(homeDir, ".claude", ".credentials.json"),
        JSON.stringify({ mcpOAuth: { "some-server": { accessToken: "x" } } }),
    )
    assert.equal(claudeCredentialsAbsent(), true)
})

test("claudeCredentialsAbsent: an unreadable credentials file is not absence", (t) => {
    if (process.platform === "darwin") {
        t.skip("macOS resolves absence through the Keychain")
        return
    }
    homeDir = mkdtempSync(join(tmpdir(), "pi-claude-auth-home-"))
    process.env.HOME = homeDir
    assert.equal(claudeCredentialsAbsent(), true)

    // Present but unparseable (e.g. a torn write): destructive cleanup must
    // not treat this as "the user is logged out".
    mkdirSync(join(homeDir, ".claude"), { recursive: true })
    writeFileSync(join(homeDir, ".claude", ".credentials.json"), "{ broken")
    assert.equal(claudeCredentialsAbsent(), false)
})
