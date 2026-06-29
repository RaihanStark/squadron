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
    case 'Task': return `🤝 ${i.subagent_type || 'subagent'}${i.description ? `: ${String(i.description).slice(0, 80)}` : ''}`
    default: return `🔧 ${n}`
  }
}

// Focused specialist subagents the main agent delegates to via the SDK's built-in
// `Task` tool. Each runs in its OWN context window on a CHEAPER model, so the side
// work — searching the codebase, or running checks and reading their verbose
// output — never bloats the main conversation and never burns the expensive
// model (the two documented wins: preserve context, control cost). The SDK uses
// each agent's `description` to decide when to delegate, so they're written to
// trigger eagerly ("Use PROACTIVELY"), and each is tool-restricted to its job.
// The confine hook still applies to every subagent's tool calls, so they stay
// inside the worktree.
const SUBAGENT_MODEL = 'haiku'
const SUBAGENTS = {
  scout: {
    description:
      'Read-only codebase scout that runs on a cheaper, faster model in its own context window. Use PROACTIVELY for ANY read-only investigation: locating files, searching for symbols/usages/strings, reading files, tracing how something works, or summarizing code — anything that does NOT modify files. Strongly prefer delegating to a scout over reading or grepping yourself, even for a single lookup, and spawn several in parallel for independent questions. It returns a tight summary, so your context stays lean and the run stays cheap. Only skip it for a file you must open in order to edit it.',
    prompt: `You are a fast, read-only scout exploring a code repository on behalf of a parent engineering agent. Your job is to find things and report back concisely — never modify files.

- Use Grep/Glob to locate code and Read to inspect it; batch independent searches into one step.
- Answer exactly what was asked. Lead with the conclusion, then cite concrete file:line references.
- Keep the summary tight — the parent pays for every token you return. Don't paste large code blocks; point to locations instead.`,
    tools: ['Read', 'Grep', 'Glob'],
    model: SUBAGENT_MODEL,
  },
  verifier: {
    description:
      "Runs the project's checks — tests, build, lint, typecheck — on a cheaper model in its own context, then reports a concise PASS/FAIL verdict with only the relevant failing output. Use PROACTIVELY after making changes, or whenever you need to know whether something works, instead of running long commands yourself — the verbose logs stay out of your conversation. Tell it exactly which command(s) to run.",
    prompt: `You are a verification subagent for a parent engineering agent. Run ONLY the check command(s) the parent asks for — tests, build, lint, or typecheck — and report back tightly. Never modify files or attempt fixes.

- Run the requested command(s) with Bash. If the parent didn't name one, infer it from the project (package.json scripts, Makefile, etc.) and state which you ran.
- Lead with a one-line verdict: PASS or FAIL.
- On FAIL, include ONLY the failing test names and the key error lines — not the whole log. The parent pays for every token you return.
- Report what passed and what failed; leave the fixing to the parent.`,
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: SUBAGENT_MODEL,
  },
}

// Which subagents are available in a given permission mode. Planning is read-only,
// so the planner only gets the read-only scout; write-capable runs also get the
// verifier, which executes checks via Bash. (The SDK fixes `agents` at session
// creation, so a session that starts in plan mode keeps the scout-only set even
// after it flips to execution — the warm path can still run checks itself; only
// the standalone verifier specialist is reserved for cold autonomous runs.)
function subagentsFor(permissionMode) {
  return permissionMode === 'plan' ? { scout: SUBAGENTS.scout } : SUBAGENTS
}

// The subagent that produced a message, or null if it came from the lead agent.
// The SDK forwards a subagent's tool calls as assistant messages tagged with a
// `parent_tool_use_id` (and usually `subagent_type`, e.g. 'scout'), so we can
// surface them as junior-rank lines in the UI instead of mixing them in with the
// lead agent's own activity.
export function subagentLabel(msg) {
  if (!msg?.parent_tool_use_id) return null
  return msg.subagent_type || 'subagent'
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
      agents: subagentsFor(permissionMode), // delegate grunt work to cheaper subagents (scout only while planning)
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
export async function runExecution({ prompt, cwd, model = 'opus', onEvent, signal, askUser, resume, output }) {
  const { query, createSdkMcpServer, tool } = await sdk()

  const tools = []
  if (askUser) {
    tools.push(tool(
      'ask_user',
      'Ask the human operator a clarifying question and WAIT for their answer. Use ONLY when a wrong assumption would be expensive or irreversible.',
      { question: z.string().describe('The clarifying question to put to the operator') },
      async ({ question }) => ({ content: [{ type: 'text', text: await askUser(question) }] }),
    ))
  }
  // Optional structured output: the agent calls a typed "submit" tool to return
  // its result, so we read validated args instead of regex-scraping its prose.
  let captured = null
  if (output) {
    tools.push(tool(output.name, output.description, output.schema, async (args) => {
      captured = output.normalize ? output.normalize(args) : args
      return { content: [{ type: 'text', text: 'Recorded.' }] }
    }))
  }
  const mcpServers = tools.length ? { squadron: createSdkMcpServer({ name: 'squadron', version: '0.1.0', tools }) } : {}

  const baseOptions = {
    cwd, model, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, mcpServers,
    agents: SUBAGENTS, // write-capable run → full specialist set (scout + verifier) on the cheaper model
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
          case 'assistant': {
            const sub = subagentLabel(msg)
            for (const b of msg.message?.content ?? []) {
              if (b.type === 'text' && b.text?.trim()) {
                if (sub) continue // a subagent's prose never overwrites the lead agent's summary
                summary = b.text.trim(); onEvent({ kind: 'text', text: summary })
              } else if (b.type === 'tool_use' && !b.name?.endsWith('ask_user') && !(output && b.name?.endsWith(output.name))) {
                onEvent({ kind: 'tool', text: describeTool(b), ...(sub ? { sub } : {}) })
              }
            }
            break
          }
          case 'result': {
            if (msg.result) summary = msg.result
            const ok = !msg.is_error && msg.subtype === 'success'
            onEvent({ kind: 'result', ok, text: ok ? 'execution finished' : `stopped: ${msg.subtype}`, costUsd: msg.total_cost_usd, numTurns: msg.num_turns })
            return { ok, summary, costUsd: msg.total_cost_usd, subtype: msg.subtype, output: captured }
          }
        }
      }
      return { ok: false, summary, error: 'stream ended without a result', output: captured }
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

// Largest --stat summary we'll feed the namer (a guard; the summary is small).
const NAME_DIFF_MAX = 50000

// Give a one-shot helper model a "submit" tool to return its answer as a typed
// tool call, instead of us regex-scraping JSON out of its prose. Optional `extras`
// register additional tools the model may call before submitting — e.g. on-demand
// retrieval, so we can front-load a small summary and let it pull only what it
// needs (saving tokens). Returns the MCP server to register, the fully-qualified
// tool names to allow, and a getter for the captured (normalized) value — null
// until the model calls the submit tool.
function makeOutputCapture(createSdkMcpServer, tool, { name, description, schema, normalize, extras = [] }) {
  let captured = null
  const submit = tool(name, description, schema, async (args) => {
    captured = normalize ? normalize(args) : args
    return { content: [{ type: 'text', text: 'Recorded.' }] }
  })
  const built = extras.map((e) => tool(e.name, e.description, e.schema, e.handler))
  const names = [name, ...extras.map((e) => e.name)]
  return {
    mcpServers: { squadron: createSdkMcpServer({ name: 'squadron', version: '0.1.0', tools: [submit, ...built] }) },
    allowedTools: names.map((n) => `mcp__squadron__${n}`),
    get: () => captured,
  }
}

// Normalize the marshal's submitted decision into { agentId, reason }: a trimmed
// string agentId or null, and a short (<=200 char) reason or null. Exported so
// it can be unit-tested without driving a live model.
export function normalizeChoice({ agentId, reason } = {}) {
  return {
    agentId: typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null,
    reason: (reason ? String(reason).trim() : '').slice(0, 200) || null,
  }
}

// Normalize the namer's submitted { title, commit }; returns null when both are
// empty so the caller falls back to the instruction text. Exported for testing.
export function normalizeChangeName({ title, commit } = {}) {
  const t = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 72)
  const c = String(commit || '').trim()
  if (!t && !c) return null
  return { title: t || null, commit: c || null }
}

// The MARSHAL: a cheap, tool-less orchestrator that routes a task to the best
// available agent — one who already knows the codebase or did related work, so
// it reuses its context (saving tokens and ramp-up) — or to a fresh agent when
// none fits. Returns { agentId|null, reason } or null on failure (→ caller falls
// back to its own heuristic).
export async function chooseAgent({ instruction, repo, candidates, model = 'haiku' }) {
  if (!candidates?.length) return { agentId: null, reason: null }
  const list = candidates.map((c, i) =>
    `${i + 1}. id=${c.agentId} · callsign=${c.name} · knowsThisRepo=${c.knowsRepo ? 'yes' : 'no'} · recentWork=${(c.focus || []).join(' | ') || '(unknown)'}`,
  ).join('\n')
  const prompt = `You are the MARSHAL, orchestrating a fleet of autonomous coding agents. A new task has arrived. Pick the BEST existing agent to handle it — one who already knows this codebase or did closely related work, so they reuse their context instead of cold-starting. If none is a genuinely good fit, start a fresh agent.

REPO: ${repo}
TASK: ${String(instruction || '(no description)').slice(0, 1500)}

AVAILABLE AGENTS:
${list}

Prefer an agent with knowsThisRepo=yes and related recentWork. Only pick one if it truly helps; otherwise choose none (a fresh agent is better than forcing an unrelated one).

Call the submit_choice tool with your decision — nothing else.`

  try {
    const { query, createSdkMcpServer, tool } = await sdk()
    const out = makeOutputCapture(createSdkMcpServer, tool, {
      name: 'submit_choice',
      description: 'Submit your routing decision: which existing agent should handle the task, or null to start a fresh one.',
      schema: {
        agentId: z.string().nullable().describe('The chosen agent id from the list, or null to start a fresh agent'),
        reason: z.string().nullable().describe('One short sentence explaining the choice'),
      },
      normalize: normalizeChoice,
    })
    // maxTurns bounds the run: the marshal should make a single submit_choice
    // call, so a few turns of slack guards against a model that loops instead.
    const q = query({ prompt, options: { model, permissionMode: 'bypassPermissions', mcpServers: out.mcpServers, allowedTools: out.allowedTools, disallowedTools: [], maxTurns: 4 } })
    for await (const _ of q) { /* drain until the model calls submit_choice */ }
    return out.get()
  } catch {
    return null
  }
}

// Largest single-file diff slice we hand back when the namer asks to inspect a file.
const NAME_FILE_DIFF_MAX = 8000

// Summarize a change into a concise PR title + commit message. To keep this cheap,
// we front-load only `git diff --stat` (filenames + line counts) and expose a
// read_diff tool the namer calls to pull a specific file's hunks ONLY when the
// summary isn't enough — so it spends tokens on the files that matter instead of
// the whole diff. `readFileDiff(file)` returns one file's staged diff. Returns
// { title, commit } or null on any failure so callers can fall back to the
// instruction text.
export async function generateChangeName({ stat, instruction, readFileDiff, model = 'haiku' }) {
  const summary = String(stat || '').trim()
  if (!summary) return null
  const clipped = summary.length > NAME_DIFF_MAX ? summary.slice(0, NAME_DIFF_MAX) + '\n…[summary truncated]…' : summary
  const prompt = `You are naming a code change for review. Below is the original request and a per-file summary (\`git diff --stat\`) of what changed. Name the change by what it ACTUALLY does (not just what was asked).

If the file summary alone isn't enough to write an accurate title and commit message, call the read_diff tool with a path from the summary to see that file's actual hunks — read only the file(s) you need, not all of them. When ready, call submit_change_name with your result.

--- ORIGINAL REQUEST ---
${String(instruction || '(none)').slice(0, 2000)}
--- END REQUEST ---

--- CHANGED FILES (git diff --stat) ---
${clipped}
--- END CHANGED FILES ---`

  try {
    const { query, createSdkMcpServer, tool } = await sdk()
    const out = makeOutputCapture(createSdkMcpServer, tool, {
      name: 'submit_change_name',
      description: 'Submit the concise PR title and commit message for the change.',
      schema: {
        title: z.string().describe('Imperative summary, <= 70 chars, no trailing period'),
        commit: z.string().describe('Conventional commit subject line; optionally a blank line then a short body'),
      },
      normalize: normalizeChangeName,
      extras: readFileDiff ? [{
        name: 'read_diff',
        description: 'Return the staged diff hunks for ONE changed file. Use only when the --stat summary is not enough to name the change.',
        schema: { file: z.string().describe('A file path taken from the changed-files summary') },
        handler: async ({ file }) => {
          let d = ''
          try { d = String((await readFileDiff(file)) || '') } catch { /* unreadable path */ }
          if (d.length > NAME_FILE_DIFF_MAX) d = d.slice(0, NAME_FILE_DIFF_MAX) + '\n…[diff truncated]…'
          return { content: [{ type: 'text', text: d.trim() || `(no staged diff for "${file}")` }] }
        },
      }] : [],
    })
    // maxTurns caps the read_diff loop: a handful of file inspections plus the
    // final submit_change_name, so a model that keeps reading can't run away.
    const q = query({ prompt, options: { model, permissionMode: 'bypassPermissions', mcpServers: out.mcpServers, allowedTools: out.allowedTools, disallowedTools: [], maxTurns: 10 } })
    for await (const _ of q) { /* drain until the model calls submit_change_name */ }
    return out.get()
  } catch {
    return null
  }
}
