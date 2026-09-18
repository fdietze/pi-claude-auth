import assert from "node:assert/strict"
import { test } from "node:test"
import { buildRefreshEnv } from "./claude-cli.ts"

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
