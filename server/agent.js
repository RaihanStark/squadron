// Wraps the Claude Agent SDK and normalizes its streamed output into simple
// progress events. Auth flows through the user's existing Claude Code login
// (or ANTHROPIC_API_KEY if set) — we inherit the environment.
import { z } from 'zod'

let _sdk
async function sdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk')
  return _sdk
}

// Turn a tool_use content block into a short human-readable line.
function describeTool(block) {
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

// Runs the agent to completion. Calls onEvent({ kind, text, ... }) for each
// step. If askUser(question) is provided, the agent gets an `ask_user` tool
// that blocks on it. Returns { ok, summary, costUsd, numTurns, subtype }.
export async function runAgent({ prompt, cwd, model = 'sonnet', onEvent, signal, askUser }) {
  const { query, createSdkMcpServer, tool } = await sdk()

  // Give the agent a way to ask the human operator for clarification. The
  // handler parks until askUser() resolves, which naturally pauses the run.
  const mcpServers = {}
  if (askUser) {
    const askTool = tool(
      'ask_user',
      'Ask the human operator a clarifying question and WAIT for their answer. Use ONLY when a wrong assumption would be expensive or irreversible; otherwise make a reasonable assumption and proceed.',
      { question: z.string().describe('The clarifying question to put to the operator') },
      async ({ question }) => ({ content: [{ type: 'text', text: await askUser(question) }] }),
    )
    mcpServers.squadron = createSdkMcpServer({ name: 'squadron', version: '0.1.0', tools: [askTool] })
  }

  const q = query({
    prompt,
    options: {
      cwd,
      model,
      permissionMode: 'bypassPermissions', // fully autonomous; safe-ish since it runs in a throwaway worktree
      mcpServers,
    },
  })

  if (signal) {
    signal.addEventListener('abort', () => { q.interrupt?.().catch(() => {}) }, { once: true })
  }

  let summary = ''
  for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') onEvent({ kind: 'status', text: `agent online · ${msg.model || model}` })
        break
      case 'assistant':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) onEvent({ kind: 'text', text: block.text.trim() })
          else if (block.type === 'tool_use' && !block.name?.endsWith('ask_user')) onEvent({ kind: 'tool', text: describeTool(block) })
        }
        break
      case 'result': {
        summary = msg.result || ''
        const ok = !msg.is_error && msg.subtype === 'success'
        onEvent({
          kind: 'result', ok,
          text: ok ? 'agent finished' : `agent stopped: ${msg.subtype}`,
          costUsd: msg.total_cost_usd, numTurns: msg.num_turns,
        })
        return { ok, summary, costUsd: msg.total_cost_usd, numTurns: msg.num_turns, subtype: msg.subtype }
      }
    }
  }
  return { ok: false, summary, error: 'stream ended without a result' }
}
