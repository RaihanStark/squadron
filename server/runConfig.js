// Per-repo "how to run this project" command overrides, persisted under
// ~/.squadron. Keyed by "owner/name".
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from './git.js'

const FILE = path.join(DATA_DIR, 'run-config.json')
let cfg = null

async function load() {
  if (cfg) return
  try { cfg = JSON.parse(await readFile(FILE, 'utf8')) } catch { cfg = {} }
}

export async function getCmd(repo) {
  await load()
  return cfg[repo] || null
}

export async function setCmd(repo, command) {
  await load()
  if (command) cfg[repo] = command
  else delete cfg[repo]
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FILE, JSON.stringify(cfg, null, 2))
  return cfg[repo] || null
}
