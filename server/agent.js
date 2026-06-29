// Wraps the Claude Agent SDK. Exposes an interactive streaming session that
// can start in plan mode and later switch to autonomous execution — all within
// one context. Auth flows through the user's existing Claude Code login.
import { z } from 'zod'
import { makeConfineHook } from './confine.js'

let _sdk
async function sdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk')
  return _sdk
}

// Pull the text delta out of a partial-message stream event, or null if the
// message isn't an incremental text chunk (tool input, thinking, etc.).
export function textDelta(msg) {
  const ev = msg?.event
  if (msg?.type === 'stream_event' && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    return ev.delta.text
  }
  return null
}

// Short human-readable line for a tool_use block.
export function describeTool(block) {
  const n = block.name
  const i = block.input || {}
  switch (n) {
    case 'Bash': return `$ ${(i.command || '').slice(0, 100)}`
    case 'Edit': return `✏️  edit ${i.file_path || ''}`
    case 'Write': return `📝 write ${i.file_path || ''}`
    case 'Read': return `📖 read ${i.file_path || ''}`
    case 'Grep': return `🔍 grep "${i.pattern || ''}"`
    case 'Glob': return `🔍 glob ${i.pattern || ''}`
    case 'TodoWrite': return `📋 planning…`
    default: return `🔧 ${n}`
  }
}

// An async message queue we feed the SDK as streaming input. Yields user
// messages on demand and stays open until close() is called.
function makeInputQueue() {
  const queue = []
  let wake = null
  let closed = false
  const gen = (async function* () {
    while (true) {
      if (queue.length) { yield queue.shift(); continue }
      if (closed) return
      await new Promise((r) => { wake = r })
    }
  })()
  const bump = () => { if (wake) { const w = wake; wake = null; w() } }
  return {
    gen,
    push(text) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
      bump()
    },
    close() { closed = true; bump() },
  }
}

// Open an interactive session. onMessage receives every raw SDK message.
// Starts in plan mode but arms the skip-permissions capability so the session
// can later flip to autonomous execution via setMode('bypassPermissions').
// Returns handles to drive the conversation.
export async function openSession({ cwd, model = 'opus', permissionMode = 'plan', askUser, onMessage, planModeInstructions, resume }) {
  const { query, createSdkMcpServer, tool } = await sdk()

  const mcpServers = {}
  if (askUser) {
    const askTool = tool(
      'ask_user',
      'Ask the human operator a clarifying question and WAIT for their answer. Use ONLY when a wrong assumption would be expensive or irreversible.',
      { question: z.string().describe('The clarifying question to put to the operator') },
      async ({ question }) => ({ content: [{ type: 'text', text: await askUser(question) }] }),
    )
    mcpServers.squadron = createSdkMcpServer({ name: 'squadron', version: '0.1.0', tools: [askTool] })
  }

  const input = makeInputQueue()
  const q = query({
    prompt: input.gen,
    options: {
      cwd, model, permissionMode, mcpServers,
      includePartialMessages: true, // stream token deltas so the UI renders live
      allowDangerouslySkipPermissions: true, // arm the capability so we can flip to execute later
      hooks: makeConfineHook(cwd), // confine the agent to its worktree
      ...(planModeInstructions ? { planModeInstructions } : {}),
      ...(resume ? { resume } : {}), // continue a prior session so its built-up context is reused, not re-paid
    },
  })

  // Drain the stream in the background, forwarding every message.
  const done = (async () => {
    try {
      for await (const msg of q) onMessage(msg)
    } catch (err) {
      onMessage({ type: 'result', subtype: 'error', is_error: true, error: { message: err.message } })
    }
  })()

  return {
    send: (text) => input.push(text),
    setMode: (mode) => q.setPermissionMode(mode),
    interrupt: () => q.interrupt().catch(() => {}),
    close: () => input.close(),
    done,
  }
}

// One-shot autonomous execution run (bypassPermissions). Used after a plan is
// approved. Calls onEvent for progress; returns { ok, summary, costUsd }.
//
// `resume` is a prior session id to continue from — the agent inherits that
// conversation (e.g. the files it already read while planning) instead of
// cold-starting. If the resume fails before producing any output (e.g. the
// session was pruned from disk), we fall back to a fresh run exactly once.
export async function runExecution({ prompt, cwd, model = 'opus', onEvent, signal, askUser, resume }) {
  const { query, createSdkMcpServer, tool } = await sdk()

  const mcpServers = {}
  if (askUser) {
    const askTool = tool(
      'ask_user',
      'Ask the human operator a clarifying question and WAIT for their answer. Use ONLY when a wrong assumption would be expensive or irreversible.',
      { question: z.string().describe('The clarifying question to put to the operator') },
      async ({ question }) => ({ content: [{ type: 'text', text: await askUser(question) }] }),
    )
    mcpServers.squadron = createSdkMcpServer({ name: 'squadron', version: '0.1.0', tools: [askTool] })
  }

  const baseOptions = {
    cwd, model, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, mcpServers,
    includePartialMessages: true, // stream token deltas so the UI renders live
    hooks: makeConfineHook(cwd), // confine the agent to its worktree
  }

  let withResume = !!resume
  while (true) {
    const q = query({ prompt, options: withResume ? { ...baseOptions, resume } : baseOptions })
    if (signal) signal.addEventListener('abort', () => { q.interrupt?.().catch(() => {}) }, { once: true })

    let summary = ''
    let produced = false
    let streamBuf = '' // running total of the live text block, reset per block
    try {
      for await (const msg of q) {
        produced = true
        const delta = textDelta(msg)
        if (delta != null) { streamBuf += delta; onEvent({ kind: 'delta', text: streamBuf }); continue }
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_stop') { streamBuf = ''; continue }
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') onEvent({ kind: 'status', text: `${resume ? 'resumed · ' : 'executing · '}${msg.model || model}` })
            break
          case 'assistant':
            for (const b of msg.message?.content ?? []) {
              if (b.type === 'text' && b.text?.trim()) { summary = b.text.trim(); onEvent({ kind: 'text', text: summary }) }
              else if (b.type === 'tool_use' && !b.name?.endsWith('ask_user')) onEvent({ kind: 'tool', text: describeTool(b) })
            }
            break
          case 'result': {
            if (msg.result) summary = msg.result
            const ok = !msg.is_error && msg.subtype === 'success'
            onEvent({ kind: 'result', ok, text: ok ? 'execution finished' : `stopped: ${msg.subtype}`, costUsd: msg.total_cost_usd, numTurns: msg.num_turns })
            return { ok, summary, costUsd: msg.total_cost_usd, subtype: msg.subtype }
          }
        }
      }
      return { ok: false, summary, error: 'stream ended without a result' }
    } catch (err) {
      // A resume that dies before emitting anything → retry once from cold.
      if (withResume && !produced && !signal?.aborted) {
        withResume = false
        onEvent({ kind: 'status', text: 'Could not resume prior session — starting fresh.' })
        continue
      }
      throw err
    }
  }
}

// Largest diff we'll feed the namer — naming doesn't need the whole thing.
const NAME_DIFF_MAX = 50000

// Pull a { title, commit } object out of the namer's reply. Mirrors the
// fenced-then-loose JSON extraction used elsewhere; returns null on any failure.
function parseChangeName(text) {
  const raw = String(text || '')
  let json = null
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) json = fence[1]
  else {
    const obj = raw.match(/\{[\s\S]*\}/)
    if (obj) json = obj[0]
  }
  if (!json) return null
  try {
    const p = JSON.parse(json.trim())
    const title = String(p.title || '').trim().replace(/\s+/g, ' ').slice(0, 72)
    const commit = String(p.commit || '').trim()
    if (!title && !commit) return null
    return { title: title || null, commit: commit || null }
  } catch {
    return null
  }
}

// Pull a { agentId, reason } object out of the General's reply.
function parseChoice(text) {
  const raw = String(text || '')
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : raw.match(/\{[\s\S]*\}/)?.[0]
  if (!body) return null
  try {
    const p = JSON.parse(body.trim())
    const agentId = typeof p.agentId === 'string' && p.agentId.trim() ? p.agentId.trim() : null
    const reason = (p.reason ? String(p.reason).trim() : '').slice(0, 200) || null
    return { agentId, reason }
  } catch {
    return null
  }
}

// The GENERAL: a cheap, tool-less orchestrator that routes a task to the best
// available agent — one who already knows the codebase or did related work, so
// it reuses its context (saving tokens and ramp-up) — or to a fresh agent when
// none fits. Returns { agentId|null, reason } or null on failure (→ caller falls
// back to its own heuristic).
export async function chooseAgent({ instruction, repo, candidates, model = 'haiku' }) {
  if (!candidates?.length) return { agentId: null, reason: null }
  const list = candidates.map((c, i) =>
    `${i + 1}. id=${c.agentId} · callsign=${c.name} · knowsThisRepo=${c.knowsRepo ? 'yes' : 'no'} · recentWork=${(c.focus || []).join(' | ') || '(unknown)'}`,
  ).join('\n')
  const prompt = `You are the GENERAL, orchestrating a fleet of autonomous coding agents. A new task has arrived. Pick the BEST existing agent to handle it — one who already knows this codebase or did closely related work, so they reuse their context instead of cold-starting. If none is a genuinely good fit, start a fresh agent.

REPO: ${repo}
TASK: ${String(instruction || '(no description)').slice(0, 1500)}

AVAILABLE AGENTS:
${list}

Prefer an agent with knowsThisRepo=yes and related recentWork. Only pick one if it truly helps; otherwise choose none (a fresh agent is better than forcing an unrelated one).

Reply with EXACTLY ONE fenced \`\`\`json code block and nothing else:
{ "agentId": "<id from the list, or null>", "reason": "<one short sentence>" }`

  try {
    const { query } = await sdk()
    const q = query({ prompt, options: { model, permissionMode: 'bypassPermissions', allowedTools: [], disallowedTools: [] } })
    let out = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content ?? []) if (b.type === 'text' && b.text?.trim()) out = b.text.trim()
      } else if (msg.type === 'result' && msg.result) out = msg.result
    }
    return parseChoice(out)
  } catch {
    return null
  }
}

// Summarize a diff into a concise PR title + commit message. A cheap, tool-less
// one-shot — used to name a quick task's changes by what actually changed rather
// than the raw instruction. Returns { title, commit } or null on any failure so
// callers can fall back to the instruction text.
export async function generateChangeName({ diff, instruction, model = 'haiku' }) {
  const text = String(diff || '').trim()
  if (!text) return null
  const clipped = text.length > NAME_DIFF_MAX ? text.slice(0, NAME_DIFF_MAX) + '\n…[diff truncated]…' : text
  const prompt = `You are naming a code change for review. Below is the original request and the git diff of the changes that were made. Summarize what the diff ACTUALLY does (not just what was asked) into a concise title and commit message.

Reply with EXACTLY ONE fenced \`\`\`json code block and nothing else, of the form:
{
  "title": "<imperative summary, <= 70 chars, no trailing period>",
  "commit": "<conventional commit subject line; optionally a blank line then a short body>"
}

--- ORIGINAL REQUEST ---
${String(instruction || '(none)').slice(0, 2000)}
--- END REQUEST ---

--- DIFF ---
${clipped}
--- END DIFF ---`

  try {
    const { query } = await sdk()
    const q = query({
      prompt,
      options: { model, permissionMode: 'bypassPermissions', allowedTools: [], disallowedTools: [] },
    })
    let out = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) out = b.text.trim()
        }
      } else if (msg.type === 'result' && msg.result) {
        out = msg.result
      }
    }
    return parseChangeName(out)
  } catch {
    return null
  }
}
