const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const { OuroborosContextPlugin } = require("../../.opencode/plugins/ouroboros-context.cjs")

function seedDatabase(dbPath) {
  // We use Python for seeding because the production retrieval path is Python +
  // SQLite as well. This keeps the end-to-end test aligned with the real stack.
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys",
        "sys.path.insert(0, 'sdk/python/ouroboros')",
        "from memory import OuroborosDNA",
        "dna = OuroborosDNA(sys.argv[1], auto_migrate_legacy=False)",
        "dna.remember_lesson('SIN-Builder', 'OpenCode plugin context injection', 'Capture the latest user prompt from message events before system-transform runs.', 0.95)",
        "dna.remember_lesson('SIN-Builder', 'OpenCode token budget trimming', 'Trim injected lessons to a strict token budget so the active agent context stays compact.', 0.91)",
      ].join("; "),
      dbPath,
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
    },
  )
}

test("plugin captures prompt events and injects ranked Ouroboros lessons", async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "opensin-ouroboros-plugin-"))
  const databasePath = path.join(tempDirectory, "ouroboros.sqlite")
  seedDatabase(databasePath)

  process.env.OUROBOROS_CONTEXT_ENABLED = "1"
  process.env.OUROBOROS_CONTEXT_DEBUG = "1"
  process.env.OUROBOROS_CONTEXT_MAX_LESSONS = "3"
  process.env.OUROBOROS_CONTEXT_TOKEN_BUDGET = "180"
  process.env.OUROBOROS_DNA_PATH = databasePath
  process.env.OUROBOROS_LEGACY_DB_PATH = path.join(tempDirectory, 'missing-legacy.sqlite')

  const logs = []
  const plugin = await OuroborosContextPlugin({
    directory: path.resolve(__dirname, "../.."),
    client: {
      app: {
        log: async (entry) => {
          logs.push(entry)
        },
      },
    },
  })

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "user",
        },
      },
    },
  })

  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "session-1",
          messageID: "message-1",
          text: "Need OpenCode plugin context injection with ranking and token budget trimming.",
        },
      },
    },
  })

  const output = { system: ["base-system"] }
  await plugin["experimental.chat.system.transform"](
    {
      sessionID: "session-1",
      model: { providerID: "openai", modelID: "gpt-5.4" },
    },
    output,
  )

  assert.equal(output.system.length, 2)
  assert.match(output.system[1], /<opensin_ouroboros_lessons>/)
  assert.match(output.system[1], /Capture the latest user prompt/)
  assert.match(output.system[1], /token budget/i)

  const debugArtifactPath = path.resolve(__dirname, "../../.opencode/debug/ouroboros/session-1.json")
  assert.ok(fs.existsSync(debugArtifactPath))

  const debugPayload = JSON.parse(fs.readFileSync(debugArtifactPath, "utf8"))
  assert.ok(debugPayload.selected_count >= 2)
  assert.equal(debugPayload.injected, true)
  assert.deepEqual(debugPayload.keywords.slice(0, 4), ["opencode", "plugin", "context", "injection"])
  assert.ok(logs.length >= 1)
})
