import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
    getAuthJsonPath,
    getClaudeConfigDir,
    getClaudeCredentialsPath,
    getPiAgentDir,
} from "./paths.ts"

const overrides = [
    "PI_CODING_AGENT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const
const saved = Object.fromEntries(overrides.map((name) => [name, process.env[name]]))

afterEach(() => {
    for (const name of overrides) {
        const value = saved[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
})

test("getPiAgentDir: defaults to ~/.pi/agent", () => {
    delete process.env.PI_CODING_AGENT_DIR
    assert.equal(getPiAgentDir(), join(homedir(), ".pi", "agent"))
})

test("getPiAgentDir: honors PI_CODING_AGENT_DIR override", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir"
    assert.equal(getPiAgentDir(), "/tmp/custom-pi-dir")
})

test("getAuthJsonPath: resolves under the agent dir", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir"
    assert.equal(getAuthJsonPath(), "/tmp/custom-pi-dir/auth.json")
})

test("getClaudeConfigDir: defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    assert.equal(getClaudeConfigDir(), join(homedir(), ".claude"))
})

test("getClaudeConfigDir: honors CLAUDE_CONFIG_DIR", () => {
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-agents"
    assert.equal(getClaudeConfigDir(), "/tmp/claude-agents")
})

test("getClaudeConfigDir: CLAUDE_SECURESTORAGE_CONFIG_DIR wins over CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config"
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/tmp/claude-secure"
    assert.equal(getClaudeConfigDir(), "/tmp/claude-secure")
})

test("getClaudeConfigDir: an empty override counts as unset", () => {
    process.env.CLAUDE_CONFIG_DIR = ""
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = ""
    assert.equal(getClaudeConfigDir(), join(homedir(), ".claude"))
})

test("getClaudeCredentialsPath: resolves under the Claude config dir", () => {
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-agents"
    assert.equal(getClaudeCredentialsPath(), "/tmp/claude-agents/.credentials.json")
})
