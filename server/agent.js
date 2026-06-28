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
export async function openSession({ cwd, model = 'opus', permissionMode = 'plan', askUser, onMessage, planModeInstructions }) {
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
      allowDangerouslySkipPermissions: true, // arm the capability so we can flip to execute later
      hooks: makeConfineHook(cwd), // confine the agent to its worktree
      ...(planModeInstructions ? { planModeInstructions } : {}),
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
    hooks: makeConfineHook(cwd), // confine the agent to its worktree
  }

  let withResume = !!resume
  while (true) {
    const q = query({ prompt, options: withResume ? { ...baseOptions, resume } : baseOptions })
    if (signal) signal.addEventListener('abort', () => { q.interrupt?.().catch(() => {}) }, { once: true })

    let summary = ''
    let produced = false
    try {
      for await (const msg of q) {
        produced = true
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
