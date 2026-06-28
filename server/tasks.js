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

export async function createTask({ owner, repo, issueNumber, issueTitle, model, kind = 'plan', local = false, body = null }) {
  await load()
  const id = randomUUID().slice(0, 8)
  const task = {
    id, owner, repo, kind, issueNumber, issueTitle, local, body, model: model || 'opus',
    status: 'queued', branch: null, base: null, prUrl: null, sessionId: null,
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
