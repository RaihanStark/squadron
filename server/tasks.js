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

let loaded = false
async function load() {
  if (loaded) return
  loaded = true
  try {
    for (const t of JSON.parse(await readFile(FILE, 'utf8'))) {
      t.events = [] // don't restore stale logs
      tasks.set(t.id, t)
    }
  } catch { /* no file yet */ }
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true })
  // Persist everything except the verbose live event log.
  const data = [...tasks.values()].map(({ events, ...rest }) => rest)
  await writeFile(FILE, JSON.stringify(data, null, 2))
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

// The active task already working an issue, if any — used to dedupe so we
// never spawn a second plan agent for the same issue.
export async function findActiveByIssue(owner, repo, issueNumber) {
  await load()
  for (const t of tasks.values()) {
    if (t.owner === owner && t.repo === repo && t.issueNumber == issueNumber && ACTIVE_STATUS.has(t.status)) {
      return t
    }
  }
  return null
}

export async function createTask({ owner, repo, issueNumber, issueTitle, model }) {
  await load()
  const id = randomUUID().slice(0, 8)
  const task = {
    id, owner, repo, issueNumber, issueTitle, model: model || 'opus',
    status: 'queued', branch: null, base: null, prUrl: null,
    plan: null, question: null, summary: null, error: null, costUsd: null,
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

export function addEvent(id, event) {
  const t = tasks.get(id)
  if (!t) return
  const e = { ...event, ts: Date.now() }
  t.events.push(e)
  if (t.events.length > 800) t.events.splice(0, t.events.length - 800)
  emit(id, { type: 'event', event: e })
}

const strip = ({ events, ...rest }) => rest
