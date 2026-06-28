// Dependency installation for a worktree, monorepo-aware. Shared by the preview
// runner (so a "run" command has its deps) and the plan/execute flow (so the
// agent has working build/test tooling instead of a source-only worktree).
//
// Runs server-side (`spawn('npm', …)` on the host), so it has network access and
// is unaffected by the agent's worktree confinement. `onLine` receives each
// output line for progress reporting; callers decide where it goes.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function runInstall(dir, onLine) {
  return new Promise((resolve) => {
    const proc = spawn('npm', ['install'], { cwd: dir, env: process.env })
    const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) onLine(l) }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', () => resolve())
    proc.on('error', (e) => { onLine('npm install failed: ' + e.message); resolve() })
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
// Idempotent: dirs that already have node_modules are skipped, so it's cheap to
// call again. No-op for non-npm projects (no root package.json). Best-effort —
// install failures are logged via onLine but never throw.
export async function ensureDeps(wt, onLine = () => {}) {
  const rootPkg = readPkg(wt)
  if (!rootPkg) return
  if (!existsSync(path.join(wt, 'node_modules'))) {
    onLine('$ npm install   (root)')
    await runInstall(wt, onLine)
  }
  if (rootPkg.workspaces) return // `npm install` already linked all workspaces
  for (const dir of findSubPackages(wt)) {
    if (existsSync(path.join(dir, 'node_modules'))) continue
    onLine(`$ npm install   (${path.relative(wt, dir)})`)
    await runInstall(dir, onLine)
  }
}
