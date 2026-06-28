// Run a task's worktree so the operator can verify the change before pushing.
// Generic: launch a configurable command and stream its output. If the output
// exposes a localhost URL, the UI can embed it; otherwise (CLI, desktop GUI like
// a Go/Fyne app) the process just runs — a native window opens on the host —
// and we stream logs. One preview process per task.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { worktreePathFor } from './git.js'
import { getTask } from './tasks.js'
import * as runConfig from './runConfig.js'

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

function runInstall(taskId, wt) {
  return new Promise((resolve) => {
    const proc = spawn('npm', ['install'], { cwd: wt, env: process.env })
    const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) log(taskId, l) }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', () => resolve())
    proc.on('error', (e) => { log(taskId, 'npm install failed: ' + e.message); resolve() })
  })
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
    if (/^npm /.test(resolved.command) && !existsSync(path.join(wt, 'node_modules'))) {
      log(taskId, '$ npm install   (first run for this worktree)')
      await runInstall(taskId, wt)
    }
    p.status = 'starting'
    log(taskId, `$ ${resolved.command}`)
    const proc = spawn('sh', ['-c', resolved.command], {
      cwd: wt, detached: true, env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '1' },
    })
    p.proc = proc
    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue
        log(taskId, line)
        const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\S*/)
        if (m && !p.url) { p.url = m[0].replace('0.0.0.0', 'localhost'); p.status = 'running' }
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
