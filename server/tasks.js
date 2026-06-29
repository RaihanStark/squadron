// In-memory task store with a tiny JSON persistence layer + an event bus the
// SSE endpoint subscribes to. Status changes are persisted; the streaming
// event log is kept in memory only (it's live data, cheap to lose on restart).
import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIR } from './git.js'

const FILE = path.join(DATA_DIR, 'tasks.json')
const tasks = new Map()
export const bus = new EventEmitter()
bus.setMaxListeners(0)

// Statuses that require a live in-memory agent session. These can't survive a
// process restart, so on load we mark them interrupted. 'planned' is NOT here:
// its plan is captured, so it can still be approved after a restart.
const NEEDS_SESSION = new Set([
  'queued', 'preparing', 'planning', 'running', 'errand_idle', 'waiting', 'committing', 'pushing', 'opening_pr',
  'reviewing', 'posting',
])

let loaded = false
async function load() {
  if (loaded) return
  loaded = true
  try {
    for (const t of JSON.parse(await readFile(FILE, 'utf8'))) {
      if (!Array.isArray(t.events)) t.events = []
      // A live agent session can't survive a process restart — anything mid-flight
      // is orphaned. Mark it interrupted so the UI doesn't show a dead "running"
      // or a fake-actionable state.
      if (NEEDS_SESSION.has(t.status)) {
        t.status = 'interrupted'
        t.events.push({ kind: 'error', text: 'Server restarted — this run was interrupted.', ts: Date.now() })
      }
      tasks.set(t.id, t)
    }
  } catch { /* no file yet */ }
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true })
  // Persist the full task incl. its event log, so the stream survives reloads.
  await writeFile(FILE, JSON.stringify([...tasks.values()], null, 2))
}

// Debounced persist for high-frequency event streaming.
let persistTimer = null
function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist().catch((e) => console.error('persist failed:', e.message))
  }, 400)
}

function emit(id, payload) {
  bus.emit('task', { id, ...payload })
}

export async function listTasks() {
  await load()
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export async function getTask(id) {
  await load()
  return tasks.get(id)
}

// In-flight (non-terminal) statuses — a task in one of these owns its issue.
const ACTIVE_STATUS = new Set([
  'queued', 'preparing', 'planning', 'planned', 'running', 'waiting',
  'committing', 'pushing', 'opening_pr',
])

// The active task already working an issue/PR of a given kind, if any — used to
// dedupe so we never spawn a second agent for the same target.
export async function findActiveByIssue(owner, repo, number, kind = 'plan') {
  await load()
  for (const t of tasks.values()) {
    if (t.owner === owner && t.repo === repo && t.issueNumber == number && (t.kind || 'plan') === kind && ACTIVE_STATUS.has(t.status)) {
      return t
    }
  }
  return null
}

// Terminal statuses whose Claude session finished cleanly and is now dormant (no
// live handle), so it's safe to resume and continue with the context it built.
// Excludes 'error'/'interrupted' (the session may be mid-tool or broken).
const RESUMABLE_STATUS = new Set(['pr_open', 'no_changes', 'review_posted', 'cancelled'])

// Task kinds whose session explores the repo broadly enough to be worth carrying
// into a new task (vs. PR-scoped fix/review/resolve sessions).
const RESUMABLE_KINDS = new Set(['errand', 'plan'])

// How recently a reusable agent must have run to auto-continue it. Past this we
// cold-start instead: the repo has likely drifted and replaying a stale, bloated
// transcript can cost more than the re-exploration it saves.
const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000 // 12h

// An agent is a persistent "person": a stable agentId + callsign that spans the
// tasks it works, carrying its Claude session (context) forward. Fresh agents get
// a squadron callsign; reused ones keep theirs.
const CALLSIGNS = [
  'Maverick', 'Goose', 'Iceman', 'Viper', 'Ghost', 'Falcon', 'Raven', 'Phoenix', 'Echo', 'Saber',
  'Nomad', 'Comet', 'Razor', 'Jester', 'Slider', 'Hawk', 'Talon', 'Bandit', 'Cobra', 'Apex',
  'Zephyr', 'Orion', 'Vega', 'Atlas', 'Nova', 'Blaze', 'Spectre', 'Rogue', 'Vapor', 'Drift',
]
function mintCallsign() {
  const used = new Set([...tasks.values()].map((t) => t.agentName).filter(Boolean))
  const free = CALLSIGNS.filter((n) => !used.has(n))
  const pool = free.length ? free : CALLSIGNS
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return free.length ? pick : `${pick} ${used.size + 1}`
}
function nameForAgent(agentId) {
  for (const t of tasks.values()) if (t.agentId === agentId && t.agentName) return t.agentName
  return null
}

// The most recent dormant, healthy session for a given agent — the one we resume
// when that agent is (re)assigned. Null if the agent is busy or has none.
function latestResumableTask({ agentId, owner, repo, now = Date.now(), maxAge = Infinity }) {
  let best = null
  for (const t of tasks.values()) {
    if (agentId && t.agentId !== agentId) continue
    if (owner && (t.owner !== owner || t.repo !== repo)) continue
    if (!RESUMABLE_KINDS.has(t.kind || 'plan') || !t.sessionId) continue
    if (!RESUMABLE_STATUS.has(t.status)) continue
    if (now - (t.createdAt || 0) > maxAge) continue
    if (!best || (t.createdAt || 0) > (best.createdAt || 0)) best = t
  }
  return best
}

// The most recent reusable agent for this repo (any explore-kind) — used for the
// seamless default ("continue whoever last worked here"). Null → fresh session.
export async function findResumableAgent(owner, repo, now = Date.now()) {
  await load()
  return latestResumableTask({ owner, repo, now, maxAge: RESUME_MAX_AGE_MS })
}

// Resolve who works a new task. Returns the session to resume (if any) plus the
// agent identity to stamp on the task:
//   - fresh: true        → brand-new agent (mint a callsign)
//   - agentId given      → assign that existing person, resuming its latest session
//   - neither            → seamless default: continue this repo's recent agent
export async function resolveAssignment({ owner, repo, agentId = null, fresh = false, model = null }) {
  await load()
  if (fresh) return { resume: null, agentId: null, agentName: null, model }
  if (agentId) {
    const src = latestResumableTask({ agentId })
    if (!src) throw new Error('that agent has no session to continue right now')
    return { resume: src.sessionId, agentId, agentName: nameForAgent(agentId), model: model || src.model }
  }
  const warm = await findResumableAgent(owner, repo)
  if (warm) return { resume: warm.sessionId, agentId: warm.agentId || warm.id, agentName: warm.agentName || null, model: model || warm.model }
  return { resume: null, agentId: null, agentName: null, model }
}

// The roster of agents (persons) derived from their tasks — name, repos they
// know, last activity, and whether they currently have a resumable session.
export async function listAgents() {
  await load()
  const byId = new Map()
  for (const t of [...tasks.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    if (!t.agentId) continue
    let a = byId.get(t.agentId)
    if (!a) { a = { agentId: t.agentId, name: t.agentName, model: t.model, repos: new Set(), lastActiveAt: 0, tasks: 0, sessionId: null, assignable: false }; byId.set(t.agentId, a) }
    if (t.agentName) a.name = t.agentName
    if (t.model) a.model = t.model
    a.repos.add(`${t.owner}/${t.repo}`)
    a.lastActiveAt = Math.max(a.lastActiveAt, t.createdAt || 0)
    a.tasks++
    if (t.sessionId && RESUMABLE_STATUS.has(t.status)) { a.sessionId = t.sessionId; a.assignable = true } // tasks sorted asc → latest wins
  }
  return [...byId.values()].map((a) => ({ ...a, repos: [...a.repos] })).sort((x, y) => y.lastActiveAt - x.lastActiveAt)
}

// The agents the General may route a task to: assignable (dormant healthy
// session), within the freshness window, each with a short "focus" — the titles
// of its recent tasks — so the General can judge relatedness.
export async function resumableCandidates(owner, repo, now = Date.now()) {
  await load()
  const agents = await listAgents()
  const out = []
  for (const a of agents) {
    if (!a.assignable || now - a.lastActiveAt > RESUME_MAX_AGE_MS) continue
    const focus = [...tasks.values()]
      .filter((t) => t.agentId === a.agentId && t.issueTitle)
      .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))
      .slice(0, 3)
      .map((t) => t.issueTitle)
    out.push({ agentId: a.agentId, name: a.name, knowsRepo: a.repos.includes(`${owner}/${repo}`), lastActiveAt: a.lastActiveAt, focus })
  }
  return out
}

export async function createTask({ owner, repo, issueNumber, issueTitle, model, kind = 'plan', local = false, body = null, agentId = null, agentName = null }) {
  await load()
  const id = randomUUID().slice(0, 8)
  // Stamp the agent identity: reuse the assigned person, else mint a new one.
  const aId = agentId || randomUUID().slice(0, 8)
  const aName = agentName || nameForAgent(aId) || mintCallsign()
  const task = {
    id, owner, repo, kind, issueNumber, issueTitle, local, body, model: model || 'opus',
    agentId: aId, agentName: aName,
    status: 'queued', branch: null, base: null, headRef: null, prUrl: null, sessionId: null,
    plan: null, review: null, findings: null, question: null, summary: null, error: null, costUsd: null, staged: false,
    createdAt: Date.now(), events: [],
  }
  tasks.set(id, task)
  await persist()
  emit(id, { type: 'task', task: strip(task) })
  return task
}

export async function updateTask(id, patch) {
  const t = tasks.get(id)
  if (!t) return
  Object.assign(t, patch)
  await persist()
  emit(id, { type: 'task', task: strip(t) })
}

// Drop a task from the store entirely (used to dismiss finished/inactive agents
// and reclaim their history). Emits a 'delete' so the UI can prune it live.
export async function deleteTask(id) {
  if (!tasks.has(id)) return false
  tasks.delete(id)
  await persist()
  emit(id, { type: 'delete' })
  return true
}

// Push a transient partial-text update onto the bus only — NOT persisted and NOT
// appended to the event log. It's live token streaming; the finalized 'text'
// event is the source of truth once the turn lands.
export function streamText(id, text) {
  if (!tasks.has(id)) return
  emit(id, { type: 'stream', text })
}

export function addEvent(id, event) {
  const t = tasks.get(id)
  if (!t) return
  const e = { ...event, ts: Date.now() }
  t.events.push(e)
  if (t.events.length > 800) t.events.splice(0, t.events.length - 800)
  emit(id, { type: 'event', event: e })
  schedulePersist()
}

const strip = ({ events, ...rest }) => rest
