// The user-curated set of "active" repos shown in the sidebar. Persisted under
// ~/.squadron as a flat array of "owner/name" (nameWithOwner). Same pattern as
// runConfig.js / localIssues.js. Keeping this small list server-side lets
// /api/repos fetch metadata for only these repos instead of `gh repo list`-ing
// the user's whole fleet on every load.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from './git.js'

const FILE = path.join(DATA_DIR, 'selected-repos.json')
let selected = null

async function load() {
  if (selected) return
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'))
    selected = Array.isArray(parsed) ? parsed : []
  } catch { selected = [] }
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FILE, JSON.stringify(selected, null, 2))
}

export async function list() {
  await load()
  return [...selected]
}

export async function add(nameWithOwner) {
  await load()
  const nwo = (nameWithOwner || '').trim()
  if (nwo && !selected.includes(nwo)) {
    selected.push(nwo)
    await persist()
  }
  return [...selected]
}

export async function remove(nameWithOwner) {
  await load()
  selected = selected.filter((r) => r !== nameWithOwner)
  await persist()
  return [...selected]
}
