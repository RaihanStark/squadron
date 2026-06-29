// Bridging Claude Code's session storage across Squadron's per-task worktrees.
//
// Claude Code records each session transcript at
//   ~/.claude/projects/<dashified-cwd>/<sessionId>.jsonl
// and resumes a session by looking it up under the CURRENT working directory's
// project dir. Squadron runs every task in its own throwaway worktree, so a
// session recorded while working in one task's worktree can't be found when we
// try to resume it from a *different* task's worktree — the cwd (and thus the
// project dir) differs. That's why an assigned agent's resume always failed with
// "No conversation found with session ID".
//
// To let an assigned agent actually continue its context, we copy its transcript
// into the new worktree's project dir before resuming. Best-effort: if the
// transcript can't be located/copied, the caller cold-starts instead.
import { homedir } from 'node:os'
import path from 'node:path'
import { access, mkdir, copyFile, readdir } from 'node:fs/promises'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const PROJECTS = path.join(CONFIG_DIR, 'projects')
const exists = (p) => access(p).then(() => true, () => false)

// Claude Code's project-dir key for a working directory: the absolute path with
// every '/' and '.' turned into '-' (e.g. /home/u/.squadron/worktrees/ab →
// -home-u--squadron-worktrees-ab).
const projectKey = (cwd) => cwd.replace(/[\/.]/g, '-')

// Ensure `sessionId`'s transcript is present in `cwd`'s project dir so a resume
// from this worktree can find it. Returns true when it's in place afterwards.
export async function ensureSessionResumable(sessionId, cwd) {
  if (!sessionId || !cwd) return false
  const destFile = path.join(PROJECTS, projectKey(cwd), `${sessionId}.jsonl`)
  if (await exists(destFile)) return true // already recorded here (e.g. same worktree)

  // Find the transcript wherever Claude originally recorded it (the worktree the
  // session was created in — long since removed from disk, but its project dir
  // and transcript persist under ~/.claude/projects).
  let srcFile = null
  try {
    for (const dir of await readdir(PROJECTS)) {
      const f = path.join(PROJECTS, dir, `${sessionId}.jsonl`)
      if (await exists(f)) { srcFile = f; break }
    }
  } catch { return false }
  if (!srcFile) return false

  try {
    await mkdir(path.dirname(destFile), { recursive: true })
    await copyFile(srcFile, destFile)
    return true
  } catch { return false }
}
