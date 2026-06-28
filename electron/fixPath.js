// Repair PATH when Squadron is launched as a packaged desktop app.
//
// GUI-launched processes (clicking the app icon / Dock / .desktop file) do NOT
// inherit the PATH from your login shell — they get a bare, system-default PATH
// that omits things like /usr/local/bin, Homebrew, asdf, and nvm. That's why the
// live preview reports "npm not found" (or "git"/"go"/etc.): the binaries exist,
// but the Electron process can't see them.
//
// We fix this by asking the user's login shell for its real PATH and adopting it,
// so every child process Squadron spawns (npm install, the run command, git, …)
// can find the toolchain the user actually has installed. No-op on Windows, which
// doesn't have this login-shell-PATH problem.
import { execFileSync } from 'node:child_process'

const MARKER = '_SQUADRON_PATH_'

// Common locations a developer toolchain ends up in, used as a fallback when we
// can't interrogate the login shell.
const FALLBACK_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

// Ask the user's login + interactive shell for its PATH. Login/interactive
// (`-ilc`) is what loads ~/.zprofile, ~/.bash_profile, nvm, etc. The marker lets
// us ignore any banner text a noisy shell rc might print before our echo.
function shellPath() {
  const shell = process.env.SHELL || '/bin/bash'
  const out = execFileSync(
    shell,
    ['-ilc', `printf %s "${MARKER}"; printf %s "$PATH"`],
    { encoding: 'utf8', timeout: 5000 },
  )
  const idx = out.lastIndexOf(MARKER)
  if (idx === -1) return ''
  return out.slice(idx + MARKER.length).trim()
}

// Merge any missing fallback dirs into a PATH string.
function withFallbacks(pathStr) {
  const sep = ':'
  const entries = pathStr ? pathStr.split(sep).filter(Boolean) : []
  const seen = new Set(entries)
  for (const dir of FALLBACK_DIRS) {
    if (!seen.has(dir)) { entries.push(dir); seen.add(dir) }
  }
  return entries.join(sep)
}

// Mutate process.env.PATH in place so all later child processes inherit it.
export function fixPath() {
  if (process.platform === 'win32') return process.env.PATH
  let resolved = ''
  try {
    resolved = shellPath()
  } catch {
    // Fall back to whatever PATH we already have plus common toolchain dirs.
  }
  process.env.PATH = withFallbacks(resolved || process.env.PATH || '')
  return process.env.PATH
}

export default fixPath
