// Run a task's worktree so the operator can verify the change before pushing.
// Generic: launch a configurable command and stream its output. If the output
// exposes a localhost URL, the UI can embed it; otherwise (CLI, desktop GUI like
// a Go/Fyne app) the process just runs — a native window opens on the host —
// and we stream logs. One preview process per task.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { worktreePathFor } from './git.js'
import { getTask } from './tasks.js'
import * as runConfig from './runConfig.js'

// An OS-assigned free port.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

const previews = new Map() // taskId -> { status, url, logs, proc, command, source }

// Keep SGR color codes (rendered in the UI) but strip cursor/erase/OSC junk.
const STRIP = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g
const clean = (s) => s.replace(STRIP, '').replace(/[\r\b]/g, '')

function log(taskId, line) {
  const p = previews.get(taskId)
  if (!p) return
  p.logs.push(clean(line))
  if (p.logs.length > 500) p.logs.shift()
}

// Best-effort guess at how to run a project from its files.
function autodetect(wt) {
  const has = (f) => existsSync(path.join(wt, f))
  const read = (f) => { try { return readFileSync(path.join(wt, f), 'utf8') } catch { return '' } }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json'))
      for (const s of ['dev', 'start', 'serve', 'preview']) if (pkg.scripts?.[s]) return `npm run ${s}`
    } catch { /* ignore */ }
  }
  if (has('go.mod')) return 'go run .'
  if (has('Cargo.toml')) return 'cargo run'
  if (has('Makefile')) {
    const mk = read('Makefile')
    if (/^run:/m.test(mk)) return 'make run'
    if (/^dev:/m.test(mk)) return 'make dev'
  }
  if (has('manage.py')) return 'python manage.py runserver'
  return null
}

// Resolve the command: explicit per-repo override → .squadron.json → detection.
export async function resolveCommand(taskId) {
  const t = await getTask(taskId)
  if (!t) return null
  const wt = worktreePathFor(taskId)
  const override = await runConfig.getCmd(`${t.owner}/${t.repo}`)
  if (override) return { command: override, source: 'configured' }
  try {
    const j = JSON.parse(readFileSync(path.join(wt, '.squadron.json'), 'utf8'))
    if (j.run) return { command: j.run, source: '.squadron.json' }
  } catch { /* none */ }
  const auto = autodetect(wt)
  return auto ? { command: auto, source: 'detected' } : null
}

export async function getState(taskId) {
  const p = previews.get(taskId)
  if (p) return { status: p.status, url: p.url, logs: p.logs, command: p.command, source: p.source }
  const r = await resolveCommand(taskId).catch(() => null)
  return { status: 'stopped', url: null, logs: [], command: r?.command || null, source: r?.source || null }
}

function runInstall(taskId, dir) {
  return new Promise((resolve) => {
    const proc = spawn('npm', ['install'], { cwd: dir, env: process.env })
    const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) log(taskId, l) }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', () => resolve())
    proc.on('error', (e) => { log(taskId, 'npm install failed: ' + e.message); resolve() })
  })
}

const readPkg = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null } }
const hasDeps = (pkg) => pkg && (Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.devDependencies || {}).length)

// Sub-package dirs that need their own install (e.g. a monorepo's web/, or
// packages/*, apps/*). Skipped when the root uses npm workspaces.
function findSubPackages(wt) {
  const out = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor'])
  const bases = [wt, path.join(wt, 'packages'), path.join(wt, 'apps'), path.join(wt, 'services')]
  for (const base of bases) {
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) continue
      const sub = path.join(base, e.name)
      if (sub === wt) continue
      const pkg = readPkg(sub)
      if (hasDeps(pkg)) out.push(sub)
      if (out.length >= 8) return out // sanity cap
    }
  }
  return out
}

// Install deps for an npm project, monorepo-aware: root first, then any
// sub-packages that have their own deps (unless the root uses workspaces).
async function ensureDeps(taskId, wt) {
  const rootPkg = readPkg(wt)
  if (!rootPkg) return
  if (!existsSync(path.join(wt, 'node_modules'))) {
    log(taskId, '$ npm install   (root)')
    await runInstall(taskId, wt)
  }
  if (rootPkg.workspaces) return // `npm install` already linked all workspaces
  for (const dir of findSubPackages(wt)) {
    if (existsSync(path.join(dir, 'node_modules'))) continue
    log(taskId, `$ npm install   (${path.relative(wt, dir)})`)
    await runInstall(taskId, dir)
  }
}

export async function start(taskId) {
  if (previews.get(taskId)?.proc) return getState(taskId)
  const wt = worktreePathFor(taskId)
  if (!existsSync(wt)) throw new Error('worktree no longer exists')
  const resolved = await resolveCommand(taskId)
  if (!resolved) throw new Error('No run command found — set one for this repo (e.g. "go run .", "npm run dev").')

  const p = { status: 'preparing', url: null, logs: [], proc: null, command: resolved.command, source: resolved.source }
  previews.set(taskId, p)

  ;(async () => {
    // npm-based command on a fresh worktree → install root + sub-package deps.
    if (/\bnpm\b/.test(resolved.command) && existsSync(path.join(wt, 'package.json'))) {
      await ensureDeps(taskId, wt)
    }
    // Run in an ISOLATED environment so a previewed app (notably Squadron
    // itself) doesn't collide with the real instance — its own free ports and
    // its own data dir. These env vars are harmless to apps that ignore them.
    const [apiPort, webPort] = await Promise.all([freePort(), freePort()])
    const env = {
      ...process.env,
      BROWSER: 'none', FORCE_COLOR: '1',
      PORT: String(apiPort),                                   // backend (PORT convention)
      VITE_PORT: String(webPort),                              // frontend dev server
      VITE_API_TARGET: `http://localhost:${apiPort}`,          // proxy → this preview's backend
      SQUADRON_DATA_DIR: path.join(os.tmpdir(), `squadron-preview-${taskId}`), // isolated ~/.squadron
    }
    p.status = 'starting'
    log(taskId, `$ ${resolved.command}   (isolated · ports ${webPort}/${apiPort})`)
    const proc = spawn('sh', ['-c', resolved.command], { cwd: wt, detached: true, env })
    p.proc = proc
    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue
        log(taskId, line)
        const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\S*/)
        if (m) {
          const url = m[0].replace('0.0.0.0', 'localhost')
          // A "Local:" line (vite/CRA/next) is the web app — prefer it over an API URL.
          if (/local/i.test(line) || !p.url) { p.url = url; p.status = 'running' }
        }
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (e) => { p.status = 'error'; log(taskId, 'failed to start: ' + e.message) })
    proc.on('exit', (code) => { p.proc = null; if (p.status !== 'stopped') p.status = 'exited'; log(taskId, `— process exited (code ${code}) —`) })
    // No URL after a moment? It's a CLI/GUI run — mark it running anyway.
    setTimeout(() => { if (p.proc && p.status === 'starting') p.status = 'running' }, 4000)
  })().catch((e) => { p.status = 'error'; log(taskId, e.message) })

  return getState(taskId)
}

export function stop(taskId) {
  const p = previews.get(taskId)
  if (p?.proc) {
    try { process.kill(-p.proc.pid, 'SIGTERM') } catch { try { p.proc.kill('SIGTERM') } catch { /* gone */ } }
  }
  if (p) { p.status = 'stopped'; p.proc = null }
  return getState(taskId)
}
