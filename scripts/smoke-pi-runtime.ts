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
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const PI = "vanilla-pi"
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

function assertNoCrash(output: string, label: string): void {
    for (const marker of ["Proxy handler", "TypeError:", "Bun v"]) {
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

        const before = countClaudeProcesses()
        const { output } = run("reply PONG", {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            PI_CLAUDE_AUTH_DEBUG: join(home, "debug.log"),
        })

        assertNoCrash(output, "expired login")

        if (!output.includes("login expired or revoked")) {
            fail("expired login: no actionable message in pi's output", output)
        }

        const debug = readFileSync(join(home, "debug.log"), "utf-8")
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

        if (countClaudeProcesses() > before) {
            fail(
                "expired login: a claude refresh process was left behind",
                output,
            )
        }

        console.log("ok  expired login: warned, no crash, no leftovers")
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

    const { output } = run("reply PONG and nothing else", process.env)
    assertNoCrash(output, "real credentials")
    if (!output.includes("PONG")) {
        fail("real credentials: no model reply", output)
    }
    console.log("ok  real credentials: authenticated against Anthropic")
}

expiredLoginRun()
realCredentialsRun()
console.log("smoke: pass")
