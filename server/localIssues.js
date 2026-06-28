// Local-only backlog items — issues you draft in Squadron without (yet) posting
// to GitHub. Persisted under ~/.squadron. Shaped to look like GitHub issues
// (number: null, local: true) so the backlog can render them alongside.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIR } from './git.js'

const FILE = path.join(DATA_DIR, 'local-issues.json')
let items = null

async function load() {
  if (items) return
  try { items = JSON.parse(await readFile(FILE, 'utf8')) } catch { items = [] }
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FILE, JSON.stringify(items, null, 2))
}

const shape = (i) => ({
  id: i.id, number: null, local: true, title: i.title, body: i.body || '',
  labels: i.labels || [], comments: 0, createdAt: i.createdAt,
  updatedAt: new Date(i.createdAt).toISOString(), url: null,
})

export async function list(repo) {
  await load()
  return items.filter((i) => i.repo === repo).sort((a, b) => b.createdAt - a.createdAt).map(shape)
}

export async function get(id) {
  await load()
  const i = items.find((x) => x.id === id)
  return i ? shape(i) : null
}

export async function create(repo, { title, body }) {
  await load()
  const item = { id: 'L' + randomUUID().slice(0, 8), repo, title, body: body || '', labels: [], createdAt: Date.now() }
  items.push(item)
  await persist()
  return shape(item)
}

export async function update(id, { title, body }) {
  await load()
  const i = items.find((x) => x.id === id)
  if (!i) return null
  if (title != null) i.title = title
  if (body != null) i.body = body
  await persist()
  return shape(i)
}

export async function remove(id) {
  await load()
  items = items.filter((i) => i.id !== id)
  await persist()
}
