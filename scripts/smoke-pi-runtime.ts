/**
 * Smoke test in the REAL pi runtime.
 *
 * The unit tests run under node, but the extension runs inside pi's embedded
 * Bun, whose `node:fs` is a Proxy. Code that passes under node can still kill
 * pi there (a dependency caching a Symbol on the fs module did exactly that),
 * so every release has to be exercised in pi itself.
 *
 * Two runs:
 *
 * 1. expired login, isolated HOME — the important one. It takes two locks in
 *    one process (auth.json seed, then the refresh lock), which is what
 *    triggered the crash, and it must end in the actionable "login expired"
 *    message instead. A stub `claude` on PATH keeps this offline: the real CLI
 *    is never started and no refresh token is ever redeemed.
 * 2. real credentials — checks the happy path still authenticates. Skipped when
 *    the real credentials are missing or expired, since refreshing them is not
 *    this test's business.
 */
import { spawnSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Which pi to test. `pi` on PATH is sometimes a wrapper (a sandbox, or a shim
 * that cannot reach its own assets), so the raw binary is tried as well and
 * PI_SMOKE_BIN overrides both. A candidate counts as usable when the extension
 * actually initialised under it, which is what the debug log proves.
 */
const PI_CANDIDATES = process.env.PI_SMOKE_BIN
    ? [process.env.PI_SMOKE_BIN]
    : ["pi", "vanilla-pi"]
let PI = PI_CANDIDATES[0]

/**
 * pi must be the installed binary, not the `pi` that this repo's own
 * devDependency puts into node_modules/.bin: that one runs on node, which is
 * the runtime whose green tests missed the bug this test exists for.
 */
const SMOKE_PATH = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => !entry.includes("node_modules/.bin"))
    .join(":")
const MODEL = "anthropic/claude-haiku-4-5"
const EXTENSION = join(process.cwd(), "src", "index.ts")

function run(
    prompt: string,
    env: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
    const result = spawnSync(
        PI,
        ["-p", prompt, "-e", EXTENSION, "--model", MODEL, "--no-session"],
        { env, encoding: "utf-8", timeout: 180_000 },
    )
    return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    }
}

function fail(message: string, output: string): never {
    console.error(`FAIL: ${message}\n--- pi output ---\n${output}`)
    process.exit(1)
}

/**
 * `Bun v<version>` is the banner Bun prints when it dies on an uncaught error.
 * Only run 1 also rejects a bare TypeError, because run 2's output contains
 * model text that could legitimately mention one.
 */
function assertNoCrash(output: string, label: string, strict: boolean): void {
    const markers = strict
        ? ["Proxy handler", "TypeError:", "Bun v1."]
        : ["Proxy handler", "Bun v1."]
    for (const marker of markers) {
        if (output.includes(marker)) {
            fail(`${label}: pi crashed (${marker})`, output)
        }
    }
}

function countClaudeProcesses(): number {
    const ps = spawnSync("pgrep", ["-fa", "claude -p . --model haiku"], {
        encoding: "utf-8",
    })
    return (ps.stdout ?? "").trim()
        ? (ps.stdout ?? "").trim().split("\n").length
        : 0
}

function expiredLoginRun(): void {
    const home = mkdtempSync(join(tmpdir(), "pi-claude-auth-smoke-"))
    try {
        // An expired login with tokens that exist nowhere: nothing here can be
        // redeemed even if something tried.
        mkdirSync(join(home, ".claude"), { recursive: true })
        writeFileSync(
            join(home, ".claude", ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: "smoke-test-not-a-real-token",
                    refreshToken: "smoke-test-not-a-real-token",
                    expiresAt: Date.now() - 3_600_000,
                    subscriptionType: "max",
                },
            }),
        )

        // A `claude` that fails immediately: the delegated refresh must be
        // attempted and must not reach the real CLI.
        const bin = join(home, "bin")
        mkdirSync(bin, { recursive: true })
        const stub = join(bin, "claude")
        writeFileSync(stub, "#!/bin/sh\nexit 1\n")
        chmodSync(stub, 0o755)

        const debugLog = join(home, "debug.log")
        const env = {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
            PATH: `${bin}:${SMOKE_PATH}`,
            PI_CLAUDE_AUTH_DEBUG: debugLog,
        }

        const before = countClaudeProcesses()
        let output = ""
        for (const candidate of PI_CANDIDATES) {
            PI = candidate
            output = run("reply PONG", env).output
            if (existsSync(debugLog)) break
        }
        if (!existsSync(debugLog)) {
            fail(
                `no usable pi binary (tried ${PI_CANDIDATES.join(", ")}); ` +
                    "set PI_SMOKE_BIN",
                output,
            )
        }

        assertNoCrash(output, "expired login", true)

        if (!output.includes("login expired or revoked")) {
            fail("expired login: no actionable message in pi's output", output)
        }

        const debug = readFileSync(debugLog, "utf-8")
        for (const event of ["seed_auth_json", "refresh_started"]) {
            if (!debug.includes(event)) {
                fail(
                    `expired login: ${event} missing from the debug log`,
                    debug,
                )
            }
        }

        // Both locks were taken in one pi process, which is what used to crash.
        const authJson = readFileSync(
            join(home, ".pi", "agent", "auth.json"),
            "utf-8",
        )
        if (JSON.parse(authJson).anthropic?.refresh !== "") {
            fail(
                "expired login: auth.json must not carry a refresh token",
                authJson,
            )
        }

        // The lock must be gone: release correctness inside pi's runtime is
        // exactly what the node tests cannot reach.
        if (existsSync(join(home, ".pi", "agent", "claude-refresh.lock"))) {
            fail("expired login: the refresh lock was left behind", output)
        }

        // Advisory only: the match is machine-wide, so another pi refreshing
        // right now would look like our leftover.
        if (countClaudeProcesses() > before) {
            console.warn(
                "warn expired login: a claude refresh process is running; " +
                    "check it is not ours",
            )
        }

        console.log(`ok  expired login (${PI}): warned, no crash, no leftovers`)
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
}

function realCredentialsRun(): void {
    let expiresAt = 0
    try {
        const raw = readFileSync(
            join(homedir(), ".claude", ".credentials.json"),
            "utf-8",
        )
        expiresAt = JSON.parse(raw).claudeAiOauth?.expiresAt ?? 0
    } catch {
        console.log("skip real credentials: no credentials file")
        return
    }
    if (expiresAt <= Date.now() + 5 * 60_000) {
        console.log("skip real credentials: expired; run `claude` first")
        return
    }

    const { output } = run("reply PONG and nothing else", {
        ...process.env,
        PATH: SMOKE_PATH,
    })
    assertNoCrash(output, "real credentials", false)
    if (!output.includes("PONG")) {
        fail("real credentials: no model reply", output)
    }
    console.log("ok  real credentials: authenticated against Anthropic")
}

expiredLoginRun()
realCredentialsRun()
console.log("smoke: pass")
