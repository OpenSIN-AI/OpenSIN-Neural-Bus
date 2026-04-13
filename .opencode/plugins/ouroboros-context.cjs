const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

// ============================================================================
// OpenSIN Neural Bus - OpenCode Ouroboros Context Plugin
// ============================================================================
//
// DESCRIPTION:
// This OpenCode plugin automatically recalls relevant Ouroboros procedural
// lessons and injects them into the active agent system context.
//
// WHY:
// Software 3.0 depends on memory continuity. Operators should not have to keep
// retyping the same procedural lessons when the knowledge already exists in the
// Ouroboros store.
//
// DESIGN NOTES:
// - The plugin keeps prompt capture in JavaScript because OpenCode emits message
//   events here.
// - The heavier ranking/deduplication/token trimming stays in Python next to the
//   SQLite-backed memory layer.
// - Debug artifacts are optional, deterministic JSON files so operators can see
//   exactly what was injected and why.
// ============================================================================

const DEFAULTS = {
  enabled: true,
  debug: false,
  maxLessons: 5,
  tokenBudget: 400,
  minScore: 0.2,
  dbPath: process.env.OUROBOROS_DNA_PATH || "/tmp/ouroboros_dna.sqlite",
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined) {
    return fallback
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function readNumberEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === "") {
    return fallback
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function sanitizeSessionID(sessionID) {
  return String(sessionID || "global").replace(/[^a-zA-Z0-9._-]/g, "_")
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true })
}

function buildRuntimeConfig() {
  return {
    enabled: readBooleanEnv("OUROBOROS_CONTEXT_ENABLED", DEFAULTS.enabled),
    debug: readBooleanEnv("OUROBOROS_CONTEXT_DEBUG", DEFAULTS.debug),
    maxLessons: readNumberEnv("OUROBOROS_CONTEXT_MAX_LESSONS", DEFAULTS.maxLessons),
    tokenBudget: readNumberEnv("OUROBOROS_CONTEXT_TOKEN_BUDGET", DEFAULTS.tokenBudget),
    minScore: readNumberEnv("OUROBOROS_CONTEXT_MIN_SCORE", DEFAULTS.minScore),
    dbPath: process.env.OUROBOROS_DNA_PATH || DEFAULTS.dbPath,
  }
}

function extractPromptFromPart(part) {
  // Only user-authored text parts should influence memory recall. Synthetic or
  // ignored parts would otherwise pollute the prompt cache with tool output or
  // OpenCode-generated text.
  if (!part || part.type !== "text") {
    return ""
  }
  if (part.synthetic || part.ignored) {
    return ""
  }
  return String(part.text || "").trim()
}

function writeDebugArtifact(projectDirectory, sessionID, packet) {
  const debugDirectory = path.join(projectDirectory, ".opencode", "debug", "ouroboros")
  ensureDirectory(debugDirectory)
  const debugPath = path.join(debugDirectory, `${sanitizeSessionID(sessionID)}.json`)
  fs.writeFileSync(debugPath, JSON.stringify(packet, null, 2))
  return debugPath
}

function callPythonBridge(projectDirectory, payload) {
  const bridgePath = path.join(projectDirectory, "sdk", "python", "ouroboros", "opencode_context.py")
  const stdout = execFileSync("python3", [bridgePath], {
    cwd: projectDirectory,
    input: JSON.stringify(payload),
    encoding: "utf8",
  })
  return JSON.parse(stdout || "{}")
}

function buildPromptCacheState() {
  return {
    messageMetaByID: new Map(),
    latestPromptBySession: new Map(),
    latestGlobalPrompt: "",
    latestPacketBySession: new Map(),
  }
}

async function logPacket(client, config, sessionID, packet, debugPath) {
  if (!client || !client.app || typeof client.app.log !== "function") {
    return
  }

  if (!config.debug && !packet.injected) {
    return
  }

  await client.app.log({
    body: {
      service: "opensin-ouroboros-context",
      level: packet.injected ? "info" : "debug",
      message: packet.injected
        ? `Injected ${packet.selected_count} Ouroboros lesson(s) into session ${sessionID || "global"}`
        : `No Ouroboros lessons injected for session ${sessionID || "global"}`,
      extra: {
        sessionID,
        selected_count: packet.selected_count,
        candidate_count: packet.candidate_count,
        keywords: packet.keywords,
        debug_path: debugPath || null,
        reasons: packet.lessons ? packet.lessons.map((lesson) => lesson.reasons) : [],
      },
    },
  })
}

async function OuroborosContextPlugin({ directory, client }) {
  const state = buildPromptCacheState()

  return {
    event: async ({ event }) => {
      if (!event || !event.type) {
        return
      }

      // We collect user prompt text from the event stream because the official
      // system-transform hook only receives the session ID and model, not the
      // user prompt body itself.
      if (event.type === "message.updated") {
        const info = event.properties && event.properties.info
        if (!info || !info.id) {
          return
        }

        state.messageMetaByID.set(info.id, {
          role: info.role,
          sessionID: info.sessionID,
        })
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties && event.properties.part
        const promptText = extractPromptFromPart(part)
        if (!promptText) {
          return
        }

        const messageMeta = state.messageMetaByID.get(part.messageID)
        const sessionID = (messageMeta && messageMeta.sessionID) || part.sessionID || "global"
        const role = (messageMeta && messageMeta.role) || "user"

        if (role !== "user") {
          return
        }

        state.latestPromptBySession.set(sessionID, promptText)
        state.latestGlobalPrompt = promptText
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const config = buildRuntimeConfig()
      if (!config.enabled) {
        return
      }

      const sessionID = input && input.sessionID ? input.sessionID : "global"
      const prompt = state.latestPromptBySession.get(sessionID) || state.latestGlobalPrompt
      if (!prompt) {
        return
      }

      const packet = callPythonBridge(directory, {
        prompt,
        db_path: config.dbPath,
        max_lessons: config.maxLessons,
        token_budget: config.tokenBudget,
        min_score: config.minScore,
        debug: config.debug,
      })

      state.latestPacketBySession.set(sessionID, packet)

      if (packet.injected && packet.injected_text) {
        output.system.push(packet.injected_text)
      }

      let debugPath = null
      if (config.debug) {
        debugPath = writeDebugArtifact(directory, sessionID, packet)
      }

      await logPacket(client, config, sessionID, packet, debugPath)
    },
  }
}

module.exports = {
  OuroborosContextPlugin,
}
