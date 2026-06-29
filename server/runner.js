// Task lifecycle: interactive PLAN (read-only chat) → operator approves →
// one-shot EXECUTION in the same worktree → commit → push → PR.
import { z } from 'zod'
import * as git from './git.js'
import * as gh from './github.js'
import * as questions from './questions.js'
import { openSession, runExecution, describeTool, generateChangeName, textDelta, chooseAgent } from './agent.js'
import { ensureSessionResumable } from './claudeSessions.js'
import { updateTask, addEvent, getTask, streamText, deleteTask, listTasks, resumableCandidates, findResumableAgent } from './tasks.js'
import * as preview from './preview.js'

const sessions = new Map() // taskId -> ctx

// The MARSHAL routes a task to the best agent. Returns { agentId, reason }:
// an existing agent to continue (reusing its context), or agentId=null to spin
// up a fresh one. Falls back to a recency heuristic if the Marshal is unavailable.
export async function chooseAssignment({ owner, repo, instruction }) {
  const candidates = await resumableCandidates(owner, repo)
  if (!candidates.length) return { agentId: null, reason: null }
  const decision = await chooseAgent({ instruction, repo: `${owner}/${repo}`, candidates })
  if (decision) {
    const valid = decision.agentId && candidates.some((c) => c.agentId === decision.agentId)
    return { agentId: valid ? decision.agentId : null, reason: decision.reason }
  }
  // Marshal unavailable → continue whoever last worked this repo, if anyone.
  const warm = await findResumableAgent(owner, repo)
  return { agentId: warm?.agentId || null, reason: warm?.agentId ? 'recency fallback' : null }
}

// The ask_user handler for a task: surfaces the question to the operator and
// blocks until they answer. Shared by execution, revision, and the reused
// planning session so the tool behaves identically everywhere.
function askUserFor(taskId) {
  return async (question) => {
    addEvent(taskId, { kind: 'question', text: question })
    await updateTask(taskId, { status: 'waiting', question })
    const reply = await questions.register(taskId)
    await updateTask(taskId, { status: 'running', question: null })
    addEvent(taskId, { kind: 'answer', text: reply })
    return reply
  }
}

const PLAN_INSTRUCTIONS = `You are scoping a GitHub issue for an autonomous engineer who will implement it right after you. Investigate the codebase (read-only) and produce a clear, concrete implementation plan: the approach, the specific files/functions to change, and any tests to add. Keep it tight and skimmable — markdown, a handful of bullets. The operator reviews your plan in a chat and may ask for revisions; incorporate their feedback and restate the updated plan.

Operating rules (important):
- You are already in the repository root. Use relative paths only; never cd elsewhere or access paths outside this directory.
- A file tree of the repo is provided below — use it to jump straight to the relevant files instead of discovering the structure one read at a time.
- Work in parallel: when you need to read or grep several files you already know you want, issue those tool calls TOGETHER in a single step (multiple parallel tool calls), not one after another. Minimize sequential round-trips.
- Present the plan directly as your reply. Do NOT write it to a file, do NOT call ExitPlanMode or AskUserQuestion, and do NOT discuss which tools are or aren't available.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) while scoping — the path restriction above applies only to local files, not the web.
- To ask the operator a question, simply write it in your message — they reply in the chat. The operator approves and triggers execution separately.`

// Scoping a new issue while REUSING an assigned agent's session — it keeps the
// context it already built, so skip the file-tree dump and lean on what it knows.
function planResumeFirstMessage(owner, repo, issue) {
  return `We're continuing in the SAME session, so you keep all the context you've already built up — reuse what you know about the codebase instead of re-exploring from scratch.

This is a NEW issue to scope, in a fresh read-only checkout of ${owner}/${repo} at its default branch. Stay strictly inside the working directory; relative paths only. Re-read anything you're unsure is current.

Investigate the relevant code (reusing what you already know) and propose a concrete, skimmable implementation plan.

--- ISSUE${issue.number ? ` #${issue.number}` : ' (local draft)'}: ${issue.title} ---
${issue.body || '(no description provided)'}
--- END ISSUE ---`
}

function planFirstMessage(owner, repo, issue, tree) {
  return `You are scoping work in the repository ${owner}/${repo}. The repo is checked out in your current working directory (read-only for now).

IMPORTANT: Stay strictly inside your current working directory. Use relative paths only. Do NOT cd elsewhere, reference absolute paths to other locations, or search the wider filesystem — those attempts are blocked and waste turns. Everything you need is right here.

Use the file tree below to go straight to the relevant files. When you read or grep several files, do it in ONE step with parallel tool calls rather than one at a time.

--- FILE TREE (${tree.total} files${tree.shown < tree.total ? `, first ${tree.shown}` : ''}) ---
${tree.list}
--- END FILE TREE ---

Investigate the relevant code and propose a concrete implementation plan for this issue. Keep it tight and skimmable.

--- ISSUE${issue.number ? ` #${issue.number}` : ' (local draft)'}: ${issue.title} ---
${issue.body || '(no description provided)'}
--- END ISSUE ---`
}

function errandFirstMessage(owner, repo, instruction, tree) {
  return `You are an autonomous engineer handling a quick task ("errand") in a fresh git worktree of ${owner}/${repo}. The repo is checked out in your working directory. This is a lightweight fast-lane — make the change directly; there is no separate planning step.

--- TASK ---
${instruction}
--- END TASK ---

Use the file tree below to jump straight to the relevant files. When you read or grep several files, do it in ONE step with parallel tool calls rather than one at a time.

--- FILE TREE (${tree.total} files${tree.shown < tree.total ? `, first ${tree.shown}` : ''}) ---
${tree.list}
--- END FILE TREE ---

Guidelines:
- You are already at the repository root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) — the path restriction applies only to local files, not the web.
- Work in parallel: when reading or grepping several files, issue those tool calls together in one step.
- Match the project's existing style and conventions. Run commands (build, tests, version bumps) in the worktree as needed.
- Do NOT commit, push, or open a pull request — the operator reviews and stages your changes.
- The operator may send follow-up instructions to refine the work, so keep going until they're satisfied.
- End each turn with a 1-3 sentence summary of what you changed.`
}

// First message when REUSING an agent: we resume its prior Claude session, so it
// already knows this codebase — skip the file tree and lean on what it learned.
// But it's a brand-new worktree: any edits from the earlier conversation are NOT
// on disk here, so be explicit that the working tree is clean.
function errandResumeFirstMessage(owner, repo, instruction) {
  return `We're continuing in the SAME session, so you keep all the context you've already built up — reuse what you know instead of re-exploring from scratch.

IMPORTANT: this is a NEW task in a FRESH, clean checkout of ${owner}/${repo} at its default branch. Any file changes from earlier in our conversation are NOT present here — treat the working tree as pristine and re-read a file before editing if you're unsure of its current contents.

--- NEW TASK ---
${instruction}
--- END TASK ---

Guidelines:
- You are already at the repository root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) — the path restriction applies only to local files, not the web.
- Reuse what you already know; only read files you haven't seen or need to re-check. Work in parallel when you do read or grep several files.
- Match the project's existing style and conventions. Run commands (build, tests, version bumps) in the worktree as needed.
- Do NOT commit, push, or open a pull request — the operator reviews and stages your changes.
- The operator may send follow-up instructions to refine the work, so keep going until they're satisfied.
- End each turn with a 1-3 sentence summary of what you changed.`
}

function prFixFirstMessage(owner, repo, pr, instruction, tree) {
  return `You are an autonomous engineer updating an OPEN pull request — #${pr.number} ("${pr.title}") in ${owner}/${repo}. The PR's head branch ("${pr.headRefName}") is checked out in your working directory, so your changes land on top of the existing PR. This is a quick, plan-less fast-lane to adjust the PR — often to address feedback a reviewer left on GitHub.

--- WHAT TO CHANGE ---
${instruction}
--- END ---

Use the file tree below to jump straight to the relevant files. When you read or grep several files, do it in ONE step with parallel tool calls rather than one at a time.

--- FILE TREE (${tree.total} files${tree.shown < tree.total ? `, first ${tree.shown}` : ''}) ---
${tree.list}
--- END FILE TREE ---

Guidelines:
- You are already at the repository root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) — the path restriction applies only to local files, not the web.
- Work in parallel: when reading or grepping several files, issue those tool calls together in one step.
- Match the project's existing style and conventions. Run the test suite if there is one.
- Do NOT commit, push, or open a pull request — the operator reviews and stages your changes, which then push back to this PR's branch.
- The operator may send follow-up instructions to refine the work, so keep going until they're satisfied.
- End each turn with a 1-3 sentence summary of what you changed.`
}

function executePrompt(owner, repo, issue, plan) {
  return `You are an autonomous engineer working in a fresh git worktree of ${owner}/${repo}. The repo is checked out in your working directory.

Implement the following approved plan for "${issue.title}"${issue.number ? ` (resolves issue #${issue.number})` : ''}. Follow the plan; use judgement on the details.

--- APPROVED PLAN ---
${plan}
--- END PLAN ---

Guidelines:
- You are already at the repository root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) — the path restriction applies only to local files, not the web.
- Work in parallel: when reading or grepping several files, issue those tool calls together in one step, not one at a time.
- Match the project's existing style and conventions.
- If there's a test suite, run it; add or update tests where sensible.
- Only call the \`ask_user\` tool if a wrong guess would be expensive or irreversible.
- Do NOT commit, push, or open a pull request — the harness handles git. Leave your finished changes saved in the working tree.
- End with a 2-4 sentence summary of what you changed and why.`
}

function prBody(issue, summary, plan) {
  return `${summary || 'Automated change.'}

${issue.number ? `Resolves #${issue.number}\n` : ''}
<details><summary>📋 Approved plan</summary>

${plan || '(none)'}
</details>

---
🤖 Generated by Squadron with Claude Code`
}

// --- Plan phase ---

// Open the interactive session for `ctx` and send its first message. If a RESUME
// fails before the session produces anything — e.g. the prior session was pruned
// from disk ("No conversation found with session ID") — restart once COLD so the
// task doesn't hard-fail. A generation counter makes us ignore trailing messages
// from the superseded (failed) handle so they can't clobber the fresh run.
async function openResumable(ctx, { resume, makeSession, resumeMessage, coldMessage }) {
  const launch = async (useResume) => {
    const gen = ctx.gen = (ctx.gen || 0) + 1
    if (ctx.handle) { try { ctx.handle.close() } catch { /* already closed */ } ctx.handle = null }
    ctx.produced = false
    const handle = await makeSession({
      resume: useResume ? resume : undefined,
      onMessage: (m) => {
        if (gen !== ctx.gen) return // a superseded handle's trailing message — drop it
        if ((m.type === 'system' && m.subtype === 'init') || m.type === 'assistant') ctx.produced = true
        // Resume couldn't be loaded and nothing ran yet → fall back to a cold start, once.
        if (useResume && m.type === 'result' && m.is_error && !ctx.produced) {
          addEvent(ctx.id, { kind: 'status', text: "Couldn't resume that agent's session — starting fresh instead." })
          updateTask(ctx.id, { resumed: false })
          ctx.sessionId = null // let the fresh session register its own id
          launch(false).catch((e) => { addEvent(ctx.id, { kind: 'error', text: e.message }); updateTask(ctx.id, { status: 'error', error: e.message }) })
          return
        }
        onSessionMessage(ctx, m)
      },
    })
    ctx.handle = handle
    handle.send(useResume ? resumeMessage() : await coldMessage())
  }
  await launch(!!resume)
}

// `resume` is a prior session id (from an assigned agent): the planner continues
// that conversation, keeping the codebase context it already built instead of
// cold-starting a fresh exploration of the repo.
export async function startPlan(task, { defaultBranch, resume } = {}) {
  const { id, owner, repo, issueNumber, model } = task
  try {
    await updateTask(id, { status: 'preparing', ...(resume ? { resumed: true } : {}) })
    const issue = task.local
      ? { number: null, title: task.issueTitle, body: task.body || '(no description)' }
      : (addEvent(id, { kind: 'status', text: `Fetching issue #${issueNumber}…` }), await gh.getIssue(owner, repo, issueNumber))

    addEvent(id, { kind: 'status', text: 'Preparing isolated worktree…' })
    const { path: wt, branch, base } = await git.createWorktree(owner, repo, id, defaultBranch)
    await updateTask(id, { branch, base, status: 'planning' })

    // A session lives under the worktree it was created in; make it findable from
    // this fresh worktree before resuming, else cold-start.
    const useResume = resume && (await ensureSessionResumable(resume, wt)) ? resume : null
    if (resume && useResume) addEvent(id, { kind: 'status', text: `Continuing ${task.agentName || 'an assigned agent'} — reusing its context to save tokens.` })
    else if (resume) { addEvent(id, { kind: 'status', text: `Couldn't locate ${task.agentName || 'that agent'}'s saved session — starting fresh.` }); await updateTask(id, { resumed: false }) }

    const ctx = { id, owner, repo, issue, wt, branch, base, model, phase: 'planning', lastText: '', plan: '' }
    sessions.set(id, ctx)

    await openResumable(ctx, {
      resume: useResume, // armed so ask_user works when we reuse this session to execute; falls back cold if the session is gone
      makeSession: (o) => openSession({ cwd: wt, model, permissionMode: 'plan', planModeInstructions: PLAN_INSTRUCTIONS, askUser: askUserFor(id), ...o }),
      resumeMessage: () => planResumeFirstMessage(owner, repo, issue),
      // Cold start: front-load the file tree so the planner doesn't discover the repo one read at a time.
      coldMessage: async () => planFirstMessage(owner, repo, issue, await git.trackedFiles(wt).catch(() => ({ total: 0, shown: 0, list: '(unavailable)' }))),
    })
  } catch (err) {
    console.error(`[plan ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    sessions.delete(id)
  }
}

// --- Errand phase ---
//
// A plan-less "quick task": an interactive, write-capable session in an isolated
// worktree. The operator chats with the agent and, when happy, stages the result
// into "Ready to Review" — from there it follows the normal push→PR path.
// `resume` is a prior session id (from an inactive agent the operator chose to
// reuse): the new errand continues that conversation, so the agent retains the
// codebase context it already built instead of cold-starting from scratch.
export async function startErrand(task, { instruction, defaultBranch, resume } = {}) {
  const { id, owner, repo, model } = task
  const text = instruction || task.body || task.issueTitle
  try {
    await updateTask(id, { status: 'preparing', ...(resume ? { resumed: true } : {}) })
    addEvent(id, { kind: 'status', text: 'Preparing isolated worktree…' })
    const { path: wt, branch, base } = await git.createWorktree(owner, repo, id, defaultBranch)
    await updateTask(id, { branch, base, status: 'running' })

    // A session lives under the worktree it was created in; make it findable from
    // this fresh worktree before resuming, else cold-start.
    const useResume = resume && (await ensureSessionResumable(resume, wt)) ? resume : null
    if (resume && useResume) addEvent(id, { kind: 'status', text: `Continuing ${task.agentName || 'a recent agent'} — reusing its context to save tokens.` })
    else if (resume) { addEvent(id, { kind: 'status', text: `Couldn't locate ${task.agentName || 'that agent'}'s saved session — starting fresh.` }); await updateTask(id, { resumed: false }) }

    const issue = { number: null, title: task.issueTitle }
    const ctx = { id, owner, repo, issue, wt, branch, base, model, phase: 'errand', kind: 'errand', instruction: text, lastText: '' }
    sessions.set(id, ctx)

    await openResumable(ctx, {
      resume: useResume,
      makeSession: (o) => openSession({ cwd: wt, model, permissionMode: 'bypassPermissions', askUser: askUserFor(id), ...o }),
      resumeMessage: () => errandResumeFirstMessage(owner, repo, text),
      // Cold start: front-load the file tree so the agent doesn't discover the repo one read at a time.
      coldMessage: async () => errandFirstMessage(owner, repo, text, await git.trackedFiles(wt).catch(() => ({ total: 0, shown: 0, list: '(unavailable)' }))),
    })
  } catch (err) {
    console.error(`[errand ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    sessions.delete(id)
  }
}

// --- PR fix phase ---
//
// An interactive, errand-style "quick task" scoped to an OPEN PR. Same warm chat
// loop as an errand, but the worktree is the PR's head branch — so when the
// operator stages and pushes, the changes update the existing PR in place (no new
// PR). Handy for addressing reviewer feedback left on GitHub.
export async function startPrFix(task, { instruction } = {}) {
  const { id, owner, repo, issueNumber: prNumber, model } = task
  const text = instruction || task.body || task.issueTitle
  try {
    await updateTask(id, { status: 'preparing' })
    addEvent(id, { kind: 'status', text: `Fetching PR #${prNumber}…` })
    const pr = await gh.getPr(owner, repo, prNumber)
    if (pr.isCrossRepository) {
      addEvent(id, { kind: 'error', text: "Can't update a fork PR — no push access to its branch. Update it from the fork instead." })
      await updateTask(id, { status: 'error', error: 'Cannot update a fork PR.' })
      sessions.delete(id)
      return
    }
    const headRef = pr.headRefName

    addEvent(id, { kind: 'status', text: 'Checking out PR head in a worktree…' })
    const { path: wt } = await git.createPrHeadWorktree(owner, repo, id, headRef)
    await updateTask(id, { status: 'running', branch: headRef, base: headRef, headRef, prUrl: pr.url })

    const tree = await git.trackedFiles(wt).catch(() => ({ total: 0, shown: 0, list: '(unavailable)' }))
    const issue = { number: prNumber, title: task.issueTitle }
    const ctx = { id, owner, repo, issue, wt, branch: headRef, base: headRef, model, phase: 'errand', kind: 'pr_fix', instruction: text, lastText: '' }
    sessions.set(id, ctx)

    const handle = await openSession({
      cwd: wt, model, permissionMode: 'bypassPermissions',
      askUser: askUserFor(id),
      onMessage: (m) => onSessionMessage(ctx, m),
    })
    ctx.handle = handle
    handle.send(prFixFirstMessage(owner, repo, pr, text, tree))
  } catch (err) {
    console.error(`[pr-fix ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    await git.removeWorktree(owner, repo, id).catch(() => {})
    sessions.delete(id)
  }
}

// Errand messages from the interactive session. Mirrors execution's mapping, but
// on a finished turn we go IDLE (keeping the session warm) instead of finalizing —
// the operator drives staging explicitly.
function onErrandMessage(ctx, m) {
  const { id } = ctx
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') addEvent(id, { kind: 'status', text: `agent online · ${m.model || ctx.model}` })
      break
    case 'assistant':
      ctx.streamBuf = '' // finalized turn landed — drop any live partial
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) { ctx.lastText = b.text.trim(); addEvent(id, { kind: 'text', text: ctx.lastText }) }
        else if (b.type === 'tool_use' && !b.name?.endsWith('ask_user')) addEvent(id, { kind: 'tool', text: describeTool(b) })
      }
      break
    case 'result':
      // A failed turn (e.g. a session resume that couldn't be loaded) — surface it
      // rather than parking the agent in a broken idle state.
      if (m.is_error) {
        const why = m.error?.message || `session ${m.subtype || 'error'}`
        addEvent(id, { kind: 'error', text: why })
        updateTask(id, { status: 'error', error: why })
        break
      }
      // Turn finished — await the operator's next instruction or a stage.
      updateTask(id, { status: 'errand_idle', summary: ctx.lastText })
      break
  }
}

// Every message from the long-lived session funnels through here. The session
// starts in plan mode, then (on approval) flips to autonomous execution in the
// SAME conversation — so we route by phase rather than tearing it down.
function onSessionMessage(ctx, m) {
  // Capture the session id once so we can resume this warm context later even
  // if the live handle is gone (server restart, revise).
  if (m.session_id && !ctx.sessionId) {
    ctx.sessionId = m.session_id
    updateTask(ctx.id, { sessionId: m.session_id })
  }
  // Live token streaming: accumulate the current text block and push transient
  // partials to the UI. Reset at each block boundary so text→tool→text doesn't
  // concatenate. The finalized 'text' event still lands via the phase handlers.
  const delta = textDelta(m)
  if (delta != null) { ctx.streamBuf = (ctx.streamBuf || '') + delta; streamText(ctx.id, ctx.streamBuf); return }
  if (m.type === 'stream_event' && m.event?.type === 'content_block_stop') { ctx.streamBuf = ''; return }
  if (ctx.phase === 'planning') return onPlanMessage(ctx, m)
  if (ctx.phase === 'executing') return onExecMessage(ctx, m)
  if (ctx.phase === 'errand') return onErrandMessage(ctx, m)
  // 'cancelled' / anything else: ignore trailing messages.
}

function onPlanMessage(ctx, m) {
  const { id } = ctx
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') addEvent(id, { kind: 'status', text: `planner online · ${m.model || ctx.model}` })
      break
    case 'assistant':
      ctx.streamBuf = '' // finalized turn landed — drop any live partial
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) { ctx.lastText = b.text.trim(); addEvent(id, { kind: 'text', text: ctx.lastText }) }
        else if (b.type === 'tool_use') {
          if (b.name === 'ExitPlanMode' && b.input?.plan) { ctx.lastText = b.input.plan }
          else addEvent(id, { kind: 'tool', text: describeTool(b) })
        }
      }
      break
    case 'result':
      if (m.is_error) {
        const why = m.error?.message || `session ${m.subtype || 'error'}`
        addEvent(id, { kind: 'error', text: why })
        updateTask(id, { status: 'error', error: why })
        break
      }
      // a plan turn finished — capture the latest plan and await the operator
      ctx.plan = ctx.lastText
      updateTask(id, { status: 'planned', plan: ctx.plan })
      break
  }
}

// Execution messages from the reused planning session. Mirrors runExecution's
// event mapping, then resolves ctx.execResolve when the run finishes so approve()
// can finalize. This is the warm path: the agent already explored the repo while
// planning, so there's no cold re-discovery here.
function onExecMessage(ctx, m) {
  const { id } = ctx
  switch (m.type) {
    case 'assistant':
      ctx.streamBuf = '' // finalized turn landed — drop any live partial
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) { ctx.lastText = b.text.trim(); addEvent(id, { kind: 'text', text: ctx.lastText }) }
        else if (b.type === 'tool_use' && !b.name?.endsWith('ask_user')) addEvent(id, { kind: 'tool', text: describeTool(b) })
      }
      break
    case 'result': {
      const summary = m.result || ctx.lastText || ''
      const ok = !m.is_error && m.subtype === 'success'
      addEvent(id, { kind: 'result', ok, text: ok ? 'execution finished' : `stopped: ${m.subtype}`, costUsd: m.total_cost_usd, numTurns: m.num_turns })
      ctx.execResolve?.({ ok, summary, costUsd: m.total_cost_usd, subtype: m.subtype })
      break
    }
  }
}

// Continue the warm planning session as an autonomous execution: flip the
// permission mode and send the execute prompt into the SAME conversation.
// Resolves with the execution result (or an aborted marker).
function continueAsExecution(ctx, plan, ac) {
  return new Promise((resolve) => {
    ctx.execResolve = resolve
    const onAbort = () => { ctx.handle?.interrupt(); resolve({ ok: false, aborted: true, summary: ctx.lastText || '' }) }
    if (ac.signal.aborted) return onAbort()
    ac.signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(ctx.handle.setMode('bypassPermissions'))
      .then(() => ctx.handle.send(executePrompt(ctx.owner, ctx.repo, ctx.issue, plan)))
      .catch((err) => resolve({ ok: false, summary: ctx.lastText || '', error: err.message }))
  }).finally(() => {
    ctx.execResolve = null
    try { ctx.handle?.close() } catch { /* already closed */ }
  })
}

export function sendMessage(taskId, text) {
  const ctx = sessions.get(taskId)
  if (!ctx || !ctx.handle) return false
  // Planning chat refines the plan; an errand chat sends a follow-up instruction.
  if (ctx.phase === 'planning') {
    addEvent(taskId, { kind: 'user', text })
    updateTask(taskId, { status: 'planning' })
    ctx.handle.send(text)
    return true
  }
  if (ctx.phase === 'errand') {
    addEvent(taskId, { kind: 'user', text })
    updateTask(taskId, { status: 'running' })
    ctx.handle.send(text)
    return true
  }
  return false
}

// Stage an errand's working-tree changes into "Ready to Review": commit locally
// (no push), close the warm session, and hand off to the normal push→PR flow.
// A 'pr_fix' is the same interactive session, only its push later updates the PR.
export async function stageErrand(taskId) {
  const ctx = sessions.get(taskId)
  const task = await getTask(taskId)
  if (!task || !['errand', 'pr_fix'].includes(task.kind)) return false
  if (!ctx || ctx.phase !== 'errand') {
    addEvent(taskId, { kind: 'error', text: 'This quick-task session is no longer live — start a new one.' })
    return false
  }
  const isPrFix = task.kind === 'pr_fix'
  const { owner, repo, wt, model } = ctx
  addEvent(taskId, { kind: 'status', text: 'Committing changes locally…' })
  await updateTask(taskId, { status: 'committing', summary: ctx.lastText || task.summary })

  // Stage everything first so we can diff it and name the change by what it does.
  await git.stageAll(wt)
  const diff = await git.stagedDiff(wt)
  if (!diff.trim()) {
    try { ctx.handle?.close() } catch { /* already closed */ }
    addEvent(taskId, { kind: 'status', text: 'No file changes produced.' })
    await updateTask(taskId, { status: 'no_changes' })
    await git.removeWorktree(owner, repo, taskId)
    sessions.delete(taskId)
    return false
  }

  addEvent(taskId, { kind: 'status', text: 'Naming the change…' })
  // Hand the namer only the compact --stat summary; it pulls a file's full hunks
  // via read_diff only when it needs them, instead of us pushing the whole diff.
  const named = await generateChangeName({
    stat: await git.stagedDiffStat(wt),
    instruction: ctx.instruction,
    readFileDiff: (file) => git.stagedFileDiff(wt, file),
    model,
  })
  const title = named?.title || task.issueTitle || 'Quick task'
  const message = named?.commit || ctx.instruction || title

  await git.commitStaged(wt, message)
  try { ctx.handle?.close() } catch { /* already closed */ }
  // Keep a PR-fix's PR-anchored title; rename a plain errand to what it does.
  await updateTask(taskId, { status: 'changes_ready', staged: true, ...(isPrFix ? {} : { issueTitle: title }) })
  addEvent(taskId, {
    kind: 'result', ok: true,
    text: isPrFix
      ? `Changes ready for review (local — not pushed). Review the diff, then push to update PR #${task.issueNumber}.`
      : 'Changes ready for review (local — not pushed). Review the diff, then push to open a PR.',
  })
  sessions.delete(taskId) // keep the worktree on disk for the diff + later push
  return true
}

// --- Execution phase ---

export async function approve(taskId) {
  const task0 = await getTask(taskId)
  // Review tasks: "approve" means post the review to the PR.
  if ((sessions.get(taskId)?.kind || task0?.kind) === 'review') return approveReview(taskId, task0)

  let ctx = sessions.get(taskId)

  // If the planning session was lost (e.g. the server restarted), rebuild just
  // enough context from the persisted task to execute the captured plan.
  if (!ctx) {
    const task = await getTask(taskId)
    if (!task || task.status !== 'planned' || !task.plan || !task.branch) return false
    if (!(await git.worktreeExists(taskId))) {
      addEvent(taskId, { kind: 'error', text: 'Worktree no longer exists — re-plan this issue.' })
      await updateTask(taskId, { status: 'interrupted' })
      return false
    }
    addEvent(taskId, { kind: 'status', text: 'Resuming after restart…' })
    const issue = task.local
      ? { number: null, title: task.issueTitle, body: task.body || '' }
      : await gh.getIssue(task.owner, task.repo, task.issueNumber)
    ctx = {
      id: taskId, owner: task.owner, repo: task.repo, issue,
      wt: git.worktreePathFor(taskId), branch: task.branch, base: task.base,
      model: task.model, phase: 'planning', plan: task.plan, lastText: task.plan,
      sessionId: task.sessionId || null, // resume the warm planning context if we still have it
    }
    sessions.set(taskId, ctx)
  }

  if (ctx.phase !== 'planning') return false
  ctx.phase = 'executing'
  const plan = ctx.plan || ctx.lastText

  addEvent(taskId, { kind: 'status', text: 'Plan approved — starting execution…' })

  const ac = new AbortController()
  ctx.ac = ac
  await updateTask(taskId, { status: 'running', plan })

  // Run execution in the background; the HTTP request returns immediately.
  ;(async () => {
    try {
      // Prefer continuing the warm planning session — the agent already read the
      // repo while planning, so we just flip it to autonomous and keep going.
      // Fall back to resuming (or, last resort, cold-starting) a fresh run when
      // the live handle is gone (server restarted before approval).
      const res = ctx.handle
        ? await continueAsExecution(ctx, plan, ac)
        : await runExecution({
            prompt: executePrompt(ctx.owner, ctx.repo, ctx.issue, plan),
            cwd: ctx.wt, model: ctx.model, signal: ac.signal,
            resume: ctx.sessionId,
            onEvent: (e) => e.kind === 'delta' ? streamText(taskId, e.text) : addEvent(taskId, e),
            askUser: askUserFor(taskId),
          })
      await finalize(ctx, res)
    } catch (err) {
      console.error(`[exec ${taskId}]`, err)
      addEvent(taskId, { kind: 'error', text: err.message })
      await updateTask(taskId, { status: 'error', error: err.message })
      await git.removeWorktree(ctx.owner, ctx.repo, taskId).catch(() => {})
      sessions.delete(taskId)
    }
  })()
  return true
}

// After execution: commit the agent's work LOCALLY (no push, no PR) and stage it
// in "Ready to Review". The operator reviews the diff, then pushes explicitly.
async function finalize(ctx, res) {
  const { id, owner, repo, wt, issue } = ctx
  if (ctx.ac?.signal.aborted) {
    await updateTask(id, { status: 'cancelled' })
    await git.removeWorktree(owner, repo, id)
    sessions.delete(id)
    return
  }
  addEvent(id, { kind: 'status', text: 'Committing changes locally…' })
  await updateTask(id, { status: 'committing', summary: res.summary, costUsd: res.costUsd })
  const committed = await git.commitAll(wt, issue.number ? `${issue.title}\n\nResolves #${issue.number}` : issue.title)
  if (!committed) {
    addEvent(id, { kind: 'status', text: 'No file changes produced.' })
    await updateTask(id, { status: 'no_changes' })
    await git.removeWorktree(owner, repo, id)
    sessions.delete(id)
    return
  }
  await updateTask(id, { status: 'changes_ready', staged: true })
  addEvent(id, { kind: 'result', text: 'Changes ready for review (local — not pushed). Review the diff, then push to open a PR.', ok: true })
  sessions.delete(id) // keep the worktree on disk for the diff + later push
}

// Operator approved the local changes → push the branch and open the PR.
export async function pushTask(taskId) {
  const task = await getTask(taskId)
  if (!task || task.status !== 'changes_ready' || !task.branch) return false
  if (!(await git.worktreeExists(taskId))) {
    addEvent(taskId, { kind: 'error', text: 'Worktree no longer exists — re-plan this issue.' })
    await updateTask(taskId, { status: 'interrupted' })
    return false
  }

  // CI-fix and PR-update tasks push back to the existing PR's head branch — no new PR.
  if (task.kind === 'fix' || task.kind === 'pr_fix') {
    try {
      addEvent(taskId, { kind: 'status', text: 'Pushing update to the PR branch…' })
      await updateTask(taskId, { status: 'pushing' })
      await git.pushToRef(git.worktreePathFor(taskId), task.branch)
      const note = task.kind === 'pr_fix'
        ? '🤖 Pushed an update from Squadron.'
        : '🤖 Pushed a CI fix from Squadron — re-running checks.'
      await gh.postPrComment(task.owner, task.repo, task.issueNumber, note).catch(() => {})
      await updateTask(taskId, { status: 'pr_open', prUrl: task.prUrl })
      addEvent(taskId, { kind: 'result', text: `Update pushed to PR #${task.issueNumber}${task.prUrl ? ` → ${task.prUrl}` : ''}`, ok: true })
      preview.stop(taskId)
      await git.removeWorktree(task.owner, task.repo, taskId)
      return true
    } catch (err) {
      addEvent(taskId, { kind: 'error', text: err.message })
      await updateTask(taskId, { status: 'error', error: err.message })
      return false
    }
  }

  const { owner, repo, branch, base, issueNumber } = task

  // Resolve tasks push the completed merge back to the PR's own head branch and
  // reuse the existing PR — no new branch or PR is opened.
  if (task.kind === 'resolve') {
    try {
      addEvent(taskId, { kind: 'status', text: `Pushing resolution to ${task.headRef}…` })
      await updateTask(taskId, { status: 'pushing' })
      await git.pushHead(git.worktreePathFor(taskId), task.headRef)
      await updateTask(taskId, { status: 'pr_open', prUrl: task.prUrl })
      addEvent(taskId, { kind: 'result', text: `Resolution pushed → ${task.prUrl}`, ok: true })
      preview.stop(taskId)
      await git.removeWorktree(owner, repo, taskId)
      return true
    } catch (err) {
      addEvent(taskId, { kind: 'error', text: err.message })
      await updateTask(taskId, { status: 'error', error: err.message })
      return false
    }
  }

  try {
    addEvent(taskId, { kind: 'status', text: 'Pushing branch to origin…' })
    await updateTask(taskId, { status: 'pushing' })
    await git.pushBranch(git.worktreePathFor(taskId), branch)

    addEvent(taskId, { kind: 'status', text: 'Opening pull request…' })
    await updateTask(taskId, { status: 'opening_pr' })
    const issue = task.local
      ? { number: null, title: task.issueTitle }
      : await gh.getIssue(owner, repo, issueNumber)
    const prUrl = await gh.createPr(owner, repo, {
      head: branch, base, title: issue.title, body: prBody(issue, task.summary, task.plan),
    })
    await updateTask(taskId, { status: 'pr_open', prUrl })
    addEvent(taskId, { kind: 'result', text: `Pull request opened → ${prUrl}`, ok: true })
    preview.stop(taskId)
    await git.removeWorktree(owner, repo, taskId)
    return true
  } catch (err) {
    addEvent(taskId, { kind: 'error', text: err.message })
    await updateTask(taskId, { status: 'error', error: err.message })
    return false
  }
}

// --- Review flow ---

function reviewPrompt(owner, repo, pr, diff) {
  return `You are reviewing pull request #${pr.number} ("${pr.title}") in ${owner}/${repo}. The PR's head is already checked out in your current working directory.

The complete diff is provided below — that is your primary material. You may read files in the current directory (relative paths only) for surrounding context, but you do NOT need to explore much. You are already at the repo root: never cd elsewhere, use absolute paths, or access anything outside this directory — those attempts are blocked. Do NOT modify any files; this is review-only.

Review the diff for correctness bugs, security issues, and clear quality problems. Be specific, concise, and fair — skip nitpicks unless they matter.

When done, call the submit_review tool with your assessment: a 1-2 sentence summary and a findings array (empty if you find no real issues). Anchor each finding to a NEW-file line number (the right side of the diff).

--- DIFF ---
${diff}
--- END DIFF ---`
}

// Normalize a submitted review into { summary, findings[] } with typed fields
// (string file/body, numeric-or-null line, severity defaulting to 'quality').
// Exported so it can be unit-tested without driving a live review run.
export function normalizeReview(p = {}) {
  return {
    summary: String(p.summary || '').trim(),
    findings: Array.isArray(p.findings) ? p.findings.map((f) => ({
      file: String(f.file || ''),
      line: Number.isFinite(Number(f.line)) ? Number(f.line) : null,
      severity: String(f.severity || 'quality'),
      body: String(f.body || ''),
    })) : [],
  }
}

// RIGHT-side (new-file) line numbers that are commentable, per file path —
// i.e. added/context lines present in the diff. GitHub rejects inline comments
// on lines not in the diff, so we use this to split findings.
export function commentableLines(diff) {
  const map = {}
  let path = null
  let newNum = 0
  let inHunk = false
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('diff --git')) { path = l.match(/ b\/(.+)$/)?.[1] || null; inHunk = false }
    else if (l.startsWith('+++ ')) { const p = l.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') path = p }
    else if (l.startsWith('@@')) { newNum = parseInt(l.match(/\+(\d+)/)?.[1] || '0', 10); inHunk = true }
    else if (inHunk && path) {
      if (l[0] === '+' || l[0] === ' ') { (map[path] ||= new Set()).add(newNum); newNum++ }
      else if (l[0] === '-') { /* old side: no new-file line */ }
      else inHunk = false
    }
  }
  return map
}

function reviewToMarkdown(task) {
  const out = [task.review || 'Reviewed.']
  if (task.findings?.length) {
    out.push('', '## Findings')
    for (const f of task.findings) out.push(`- **\`${f.file}:${f.line ?? '?'}\`** — _${f.severity}_ — ${f.body}`)
  } else {
    out.push('', 'No issues found.')
  }
  return out.join('\n')
}

export async function startReview(task) {
  const { id, owner, repo, issueNumber: prNumber, model } = task
  try {
    await updateTask(id, { status: 'preparing' })
    addEvent(id, { kind: 'status', text: `Fetching PR #${prNumber}…` })
    const pr = await gh.getPr(owner, repo, prNumber)
    let diff = await gh.getPrDiff(owner, repo, prNumber)
    const MAX = 60000
    if (diff.length > MAX) {
      diff = diff.slice(0, MAX) + '\n…[diff truncated]…'
      addEvent(id, { kind: 'status', text: 'Large diff truncated for review.' })
    }

    addEvent(id, { kind: 'status', text: 'Checking out PR head in a worktree…' })
    const { path: wt } = await git.createPrWorktree(owner, repo, id, prNumber)
    await updateTask(id, { status: 'reviewing' })
    addEvent(id, { kind: 'status', text: `Reviewing #${prNumber}…` })

    const ac = new AbortController()
    sessions.set(id, { id, owner, repo, kind: 'review', prNumber, wt, ac })

    const res = await runExecution({
      prompt: reviewPrompt(owner, repo, pr, diff),
      cwd: wt, model, signal: ac.signal,
      onEvent: (e) => e.kind === 'delta' ? streamText(id, e.text) : addEvent(id, e),
      output: {
        name: 'submit_review',
        description: 'Submit your code review: an overall summary and a list of findings (empty if none).',
        schema: {
          summary: z.string().describe('1-2 sentence overall assessment'),
          findings: z.array(z.object({
            file: z.string().describe('repo-relative path'),
            line: z.number().nullable().describe('line number in the NEW file (right side of the diff) this comment anchors to'),
            severity: z.enum(['bug', 'security', 'quality']).describe('severity of the finding'),
            body: z.string().describe('the problem and a concrete suggested fix'),
          })).describe('findings; empty array if no real issues'),
        },
        normalize: normalizeReview,
      },
    })

    await git.removeWorktree(owner, repo, id) // review captured; no further fs needed
    if (ac.signal.aborted) {
      await updateTask(id, { status: 'cancelled' })
      sessions.delete(id)
      return
    }
    const { summary, findings } = res.output || { summary: (res.summary || '').trim(), findings: [] }
    await updateTask(id, { status: 'reviewed', review: summary, findings, costUsd: res.costUsd })
    addEvent(id, { kind: 'status', text: `Review ready — ${findings.length} finding(s). Approve to post to the PR.` })
  } catch (err) {
    console.error(`[review ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    await git.removeWorktree(owner, repo, id).catch(() => {})
    sessions.delete(id)
  }
}

async function approveReview(taskId, task) {
  if (!task || task.status !== 'reviewed') return false
  const { owner, repo, issueNumber: prNumber } = task
  const findings = task.findings || []
  try {
    addEvent(taskId, { kind: 'status', text: 'Posting review to the PR…' })
    await updateTask(taskId, { status: 'posting' })

    // Split findings into anchorable inline comments vs. overflow (line not in diff).
    const valid = commentableLines(await gh.getPrDiff(owner, repo, prNumber))
    const inline = []
    const overflow = []
    for (const f of findings) {
      if (f.line != null && valid[f.file]?.has(f.line)) {
        inline.push({ path: f.file, line: f.line, side: 'RIGHT', body: `**${f.severity}** — ${f.body}` })
      } else overflow.push(f)
    }

    let body = task.review || 'Reviewed.'
    if (overflow.length) {
      body += '\n\n## Other findings\n' + overflow.map((f) => `- **\`${f.file}:${f.line ?? '?'}\`** — _${f.severity}_ — ${f.body}`).join('\n')
    }
    body += '\n\n---\n🤖 Reviewed by Squadron'

    let url
    if (inline.length) {
      addEvent(taskId, { kind: 'status', text: `Posting ${inline.length} inline comment(s)…` })
      try {
        url = await gh.postPrReview(owner, repo, prNumber, { body, event: 'COMMENT', comments: inline })
      } catch (err) {
        // GitHub can reject inline positions; fall back to a single summary comment.
        addEvent(taskId, { kind: 'status', text: `Inline review rejected (${err.message.slice(0, 80)}); posting as a comment.` })
        url = await gh.postPrComment(owner, repo, prNumber, `${reviewToMarkdown(task)}\n\n---\n🤖 Reviewed by Squadron`)
      }
    } else {
      url = await gh.postPrComment(owner, repo, prNumber, `${body}`)
    }

    await updateTask(taskId, { status: 'review_posted', prUrl: url })
    addEvent(taskId, { kind: 'result', text: `Review posted → ${url}`, ok: true })
    sessions.delete(taskId)
    return true
  } catch (err) {
    addEvent(taskId, { kind: 'error', text: err.message })
    await updateTask(taskId, { status: 'error', error: err.message })
    return false
  }
}

// --- CI fix: dispatch an agent to read failing CI logs and fix the build ---

function ciFixPrompt(owner, repo, pr, logs) {
  return `You are an autonomous engineer fixing failing CI on pull request #${pr.number} ("${pr.title}") in ${owner}/${repo}. The PR's head branch is already checked out in your current working directory.

CI is failing on this PR. The failing CI logs are below — use them to diagnose the problem, then fix it in the working tree.

--- FAILING CI LOGS ---
${logs}
--- END LOGS ---

Guidelines:
- You are already at the repo root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- Investigate the failure first (read the implicated files/tests), then make the smallest correct fix.
- You may use the WebSearch and WebFetch tools to look things up online (library docs, error messages, APIs) — the path restriction applies only to local files, not the web.
- Work in parallel: when reading or grepping several files, issue those tool calls together in one step.
- Match the project's existing style and conventions. If there's a test suite, run it to confirm the build is green before finishing.
- Do NOT commit, push, or open a PR — the harness handles git. Leave your finished changes saved in the working tree.
- End with a 2-4 sentence summary of what was failing and how you fixed it.`
}

// Pull the failing-step logs for every failing run on the PR, capped like the
// review diff. Falls back to a check summary if no run logs are retrievable.
async function collectFailingLogs(owner, repo, pr) {
  const MAX = 60000
  const runIds = gh.failedRunIds(pr.statusCheckRollup)
  let logs = ''
  for (const runId of runIds) {
    try {
      const log = await gh.failedRunLog(owner, repo, runId)
      if (log.trim()) logs += `\n===== run ${runId} =====\n${log}\n`
    } catch (err) {
      logs += `\n===== run ${runId} (log unavailable: ${err.message}) =====\n`
    }
  }
  if (!logs.trim()) {
    // No Actions run logs (e.g. legacy status contexts) — hand over the checks list.
    try {
      const checks = await gh.prChecks(owner, repo, pr.number)
      const failed = (checks || []).filter((c) => c.bucket === 'fail' || c.state === 'FAILURE' || c.state === 'ERROR')
      if (failed.length) logs = failed.map((c) => `- ${c.name} (${c.workflow || ''}): ${c.state} — ${c.link || ''}`).join('\n')
    } catch { /* ignore */ }
  }
  if (!logs.trim()) logs = '(No failing CI logs could be retrieved automatically — inspect the PR checks to find the failure.)'
  if (logs.length > MAX) logs = logs.slice(0, MAX) + '\n…[logs truncated]…'
  return logs
}

// Check the PR head into a writable worktree, let the agent fix the failing CI,
// then commit the fix LOCALLY and land it in "Ready to Review". The operator
// reviews the diff and pushes — and pushTask routes the fix back to the PR head.
export async function startCiFix(task) {
  const { id, owner, repo, issueNumber: prNumber, model } = task
  try {
    await updateTask(id, { status: 'preparing' })
    addEvent(id, { kind: 'status', text: `Fetching PR #${prNumber}…` })
    const pr = await gh.getPr(owner, repo, prNumber)
    const headRef = pr.headRefName
    if (gh.ciState(pr.statusCheckRollup) !== 'failure') {
      addEvent(id, { kind: 'error', text: 'CI is not failing on this PR — nothing to fix.' })
      await updateTask(id, { status: 'error', error: 'CI is not failing' })
      sessions.delete(id)
      return
    }

    addEvent(id, { kind: 'status', text: 'Gathering failing CI logs…' })
    const logs = await collectFailingLogs(owner, repo, pr)

    addEvent(id, { kind: 'status', text: 'Checking out PR head in a worktree…' })
    const { path: wt } = await git.createPrHeadWorktree(owner, repo, id, headRef)
    await updateTask(id, { status: 'running', branch: headRef, base: headRef, prUrl: pr.url })

    const ac = new AbortController()
    sessions.set(id, { id, owner, repo, kind: 'fix', prNumber, wt, branch: headRef, base: headRef, ac })

    addEvent(id, { kind: 'status', text: `Fixing CI on #${prNumber}…` })
    const res = await runExecution({
      prompt: ciFixPrompt(owner, repo, pr, logs),
      cwd: wt, model, signal: ac.signal,
      onEvent: (e) => e.kind === 'delta' ? streamText(id, e.text) : addEvent(id, e),
      askUser: askUserFor(id),
    })

    if (ac.signal.aborted) {
      await updateTask(id, { status: 'cancelled' })
      await git.removeWorktree(owner, repo, id)
      sessions.delete(id)
      return
    }

    addEvent(id, { kind: 'status', text: 'Committing fix locally…' })
    await updateTask(id, { status: 'committing', summary: res.summary, costUsd: res.costUsd })
    const committed = await git.commitAll(wt, `Fix CI for #${prNumber}`)
    if (!committed) {
      addEvent(id, { kind: 'status', text: 'No file changes produced.' })
      await updateTask(id, { status: 'no_changes' })
      await git.removeWorktree(owner, repo, id)
      sessions.delete(id)
      return
    }
    await updateTask(id, { status: 'changes_ready', staged: true })
    addEvent(id, { kind: 'result', text: 'Fix ready for review (local — not pushed). Review the diff, then push to update the PR.', ok: true })
    sessions.delete(id) // keep the worktree on disk for the diff + later push
  } catch (err) {
    console.error(`[ci-fix ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    await git.removeWorktree(owner, repo, id).catch(() => {})
    sessions.delete(id)
  }
}

// --- Resolve: AI merges base into the PR head and fixes the conflicts ---

function resolvePrompt(owner, repo, pr, conflicts) {
  return `You are resolving merge conflicts on pull request #${pr.number} ("${pr.title}") in ${owner}/${repo}. The PR's head branch ("${pr.headRefName}") is checked out in your working directory, and its base branch ("${pr.baseRefName}") has just been merged into it — leaving git conflict markers in the files below.

--- CONFLICTED FILES ---
${conflicts.map((f) => `- ${f}`).join('\n')}
--- END CONFLICTED FILES ---

Your job: open each conflicted file and resolve EVERY conflict region (the \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` blocks), preserving the intent of BOTH sides — the PR's changes AND the base branch's changes. Remove all conflict markers. When the resolution is ambiguous, read the surrounding code for context and choose the result that keeps the program correct and coherent; do not simply discard one side.

Guidelines:
- You are already at the repo root. Use relative paths only; never cd elsewhere or touch other locations — those attempts are blocked and waste turns.
- Work in parallel: when reading several files, issue those reads together in one step.
- Resolve the conflicts ONLY. Do not make unrelated changes.
- Do NOT run git (no add/commit/merge/push) and do NOT open a PR — the harness completes the merge commit and pushes. Just leave the resolved files saved in the working tree.
- If a wrong guess would be expensive or irreversible, use the \`ask_user\` tool.
- End with a 2-4 sentence summary of how you resolved the conflicts.`
}

export async function startResolve(task) {
  const { id, owner, repo, issueNumber: prNumber, model } = task
  try {
    await updateTask(id, { status: 'preparing' })
    addEvent(id, { kind: 'status', text: `Fetching PR #${prNumber}…` })
    const pr = await gh.getPr(owner, repo, prNumber)

    // Gate: only conflicting, same-repo PRs can be resolved (we need push access
    // to the head branch, which we don't have on a fork).
    if (pr.mergeable !== 'CONFLICTING') {
      addEvent(id, { kind: 'error', text: 'This PR has no merge conflicts to resolve.' })
      await updateTask(id, { status: 'error', error: 'No merge conflicts to resolve.' })
      return
    }
    if (pr.isCrossRepository) {
      addEvent(id, { kind: 'error', text: "Can't resolve conflicts on a fork PR — push access to its branch is required." })
      await updateTask(id, { status: 'error', error: 'Cannot resolve conflicts on a fork PR.' })
      return
    }

    addEvent(id, { kind: 'status', text: `Merging ${pr.baseRefName} into ${pr.headRefName}…` })
    const { path: wt, conflicts } = await git.createMergeWorktree(owner, repo, id, pr.headRefName, pr.baseRefName)
    await updateTask(id, { branch: pr.headRefName, base: pr.baseRefName, headRef: pr.headRefName, prUrl: pr.url })

    if (!conflicts.length) {
      addEvent(id, { kind: 'status', text: 'Merge produced no conflicts — nothing to resolve.' })
      await updateTask(id, { status: 'no_changes' })
      await git.removeWorktree(owner, repo, id)
      return
    }

    await updateTask(id, { status: 'running' })
    addEvent(id, { kind: 'status', text: `Resolving ${conflicts.length} conflicted file(s)…` })

    const ac = new AbortController()
    sessions.set(id, { id, owner, repo, kind: 'resolve', wt, branch: pr.headRefName, base: pr.baseRefName, ac })

    const res = await runExecution({
      prompt: resolvePrompt(owner, repo, pr, conflicts),
      cwd: wt, model, signal: ac.signal,
      onEvent: (e) => e.kind === 'delta' ? streamText(id, e.text) : addEvent(id, e),
      askUser: askUserFor(id),
    })

    if (ac.signal.aborted) {
      addEvent(id, { kind: 'status', text: 'Resolution stopped — discarding the merge worktree.' })
      await updateTask(id, { status: 'cancelled' })
      await git.removeWorktree(owner, repo, id)
      sessions.delete(id)
      return
    }

    // Guard: refuse to commit while conflict markers remain in the tree.
    if (await git.mergeHasConflictMarkers(wt)) {
      addEvent(id, { kind: 'error', text: 'Unresolved conflict markers remain — not committing. Review the worktree or retry.' })
      await updateTask(id, { status: 'error', error: 'Unresolved conflicts remain.' })
      await git.removeWorktree(owner, repo, id)
      sessions.delete(id)
      return
    }

    addEvent(id, { kind: 'status', text: 'Committing the merge locally…' })
    await updateTask(id, { status: 'committing', summary: res.summary, costUsd: res.costUsd })
    await git.commitMerge(wt)
    await updateTask(id, { status: 'changes_ready', staged: true })
    addEvent(id, { kind: 'result', text: 'Conflicts resolved (local — not pushed). Review the diff, then push to update the PR.', ok: true })
    sessions.delete(id) // keep the worktree on disk for the diff + later push
  } catch (err) {
    console.error(`[resolve ${id}]`, err)
    addEvent(id, { kind: 'error', text: err.message })
    await updateTask(id, { status: 'error', error: err.message })
    await git.removeWorktree(owner, repo, id).catch(() => {})
    sessions.delete(id)
  }
}

// --- Revise: operator asks the agent for more changes on staged work ---

function revisePrompt(owner, repo, issue, plan, instruction) {
  return `You are continuing work in a git worktree of ${owner}/${repo}. The working directory ALREADY CONTAINS your previous changes for this task (committed). The operator reviewed them and is asking for more:

--- REQUESTED CHANGES ---
${instruction}
--- END REQUESTED CHANGES ---
${plan ? `\nFor context, the original plan was:\n${plan}\n` : ''}
Guidelines:
- Build on the existing changes; make the requested adjustments in the working tree.
- You are already at the repo root. Relative paths only; never cd elsewhere — blocked.
- Work in parallel: batch independent reads/greps into one step.
- Do NOT commit, push, or open a PR — the harness handles git.
- End with a short summary of what you changed in this revision.`
}

export async function revise(taskId, instruction) {
  const task = await getTask(taskId)
  if (!task || task.status !== 'changes_ready' || !instruction?.trim()) return false
  if (!(await git.worktreeExists(taskId))) {
    addEvent(taskId, { kind: 'error', text: 'Worktree no longer exists — re-plan this issue.' })
    await updateTask(taskId, { status: 'interrupted' })
    return false
  }
  const { owner, repo, issueNumber, model } = task
  const wt = git.worktreePathFor(taskId)
  const ac = new AbortController()
  sessions.set(taskId, { id: taskId, owner, repo, wt, branch: task.branch, base: task.base, ac, revising: true })
  addEvent(taskId, { kind: 'user', text: instruction })
  await updateTask(taskId, { status: 'running' })

  ;(async () => {
    try {
      const issue = task.local
        ? { number: null, title: task.issueTitle }
        : await gh.getIssue(owner, repo, issueNumber).catch(() => ({ title: task.issueTitle }))
      const res = await runExecution({
        prompt: revisePrompt(owner, repo, issue, task.plan, instruction),
        cwd: wt, model, signal: ac.signal,
        resume: task.sessionId, // continue the warm plan→execute context instead of re-reading the repo
        onEvent: (e) => e.kind === 'delta' ? streamText(taskId, e.text) : addEvent(taskId, e),
        askUser: askUserFor(taskId),
      })
      if (ac.signal.aborted) {
        addEvent(taskId, { kind: 'status', text: 'Revision stopped — prior changes kept.' })
        await updateTask(taskId, { status: 'changes_ready' })
        sessions.delete(taskId)
        return
      }
      addEvent(taskId, { kind: 'status', text: 'Committing revision…' })
      await updateTask(taskId, { status: 'committing' })
      await git.commitAll(wt, `Revise: ${instruction.slice(0, 72)}`)
      await updateTask(taskId, { status: 'changes_ready', summary: res.summary || task.summary })
      addEvent(taskId, { kind: 'result', text: 'Revision ready — review the updated diff.', ok: true })
      sessions.delete(taskId)
    } catch (err) {
      console.error(`[revise ${taskId}]`, err)
      addEvent(taskId, { kind: 'error', text: err.message })
      await updateTask(taskId, { status: 'changes_ready' }) // keep prior changes
      sessions.delete(taskId)
    }
  })()
  return true
}

// Stop an in-flight revision without discarding the staged work.
// Statuses with no live agent session and no pending operator action — these are
// the "inactive" agents that are safe to dismiss. Mirrors the frontend's
// !ACTIVE.has(status) view in web/src/constants.js.
const DELETABLE = new Set(['pr_open', 'no_changes', 'review_posted', 'cancelled', 'error', 'interrupted'])

// Dismiss a single inactive agent: remove its worktree (if any) and drop it from
// the store. Refuses tasks that are still active or awaiting you — cancel those
// first. Returns true when the task was removed.
export async function discardTask(taskId) {
  const t = await getTask(taskId)
  if (!t) return false
  if (!DELETABLE.has(t.status)) return false
  preview.stop(taskId)
  await git.removeWorktree(t.owner, t.repo, taskId).catch(() => {})
  return deleteTask(taskId)
}

// Bulk-dismiss every inactive agent. Returns the count removed.
export async function discardInactive() {
  const all = await listTasks()
  let cleared = 0
  for (const t of all) {
    if (DELETABLE.has(t.status) && (await discardTask(t.id))) cleared++
  }
  return cleared
}

export function stopRun(taskId) {
  questions.clear(taskId)
  const ctx = sessions.get(taskId)
  if (ctx?.ac) { ctx.ac.abort(); return true }
  return false
}

export function cancel(taskId) {
  questions.clear(taskId)
  preview.stop(taskId)
  const ctx = sessions.get(taskId)
  if (ctx) {
    // Flip out of 'planning' first so the trailing 'result' from interrupting the
    // session is ignored by onPlanMessage (otherwise it resets status to 'planned').
    ctx.phase = 'cancelled'
    ctx.ac?.abort()
    ctx.handle?.interrupt()
    ctx.handle?.close()
    git.removeWorktree(ctx.owner, ctx.repo, taskId).catch(() => {})
    updateTask(taskId, { status: 'cancelled' })
    sessions.delete(taskId)
    return true
  }
  // No live session (e.g. discarding a changes_ready task awaiting review).
  // Still clean up: remove the worktree and mark it cancelled.
  ;(async () => {
    const t = await getTask(taskId)
    if (!t) return
    await git.removeWorktree(t.owner, t.repo, taskId).catch(() => {})
    await updateTask(taskId, { status: 'cancelled' })
  })()
  return true
}
