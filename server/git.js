// Git + worktree management for agent runs.
//
// Model: for each repo we keep one "mirror" clone under data/repos/<owner>__<repo>.
// Every task gets its own branch + worktree under data/worktrees/<taskId>, so
// multiple agents can work the same repo in parallel without colliding.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
// Live OUTSIDE the project tree, so an agent's worktree is never nested inside
// (or adjacent to) Squadron's own source — part of keeping agents confined.
export const DATA_DIR = path.join(os.homedir(), '.squadron')
const REPOS_DIR = path.join(DATA_DIR, 'repos')
const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees')

const exists = (p) => access(p).then(() => true, () => false)
const git = (args, cwd) => run('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 })

const slug = (owner, repo) => `${owner}__${repo}`
const mirrorPath = (owner, repo) => path.join(REPOS_DIR, slug(owner, repo))
const worktreePath = (taskId) => path.join(WORKTREES_DIR, taskId)

// Deterministic worktree path for a task (used to rebuild context after a restart).
export const worktreePathFor = (taskId) => worktreePath(taskId)
export const worktreeExists = (taskId) => exists(worktreePath(taskId))

// Ensure we have a local clone of the repo to base worktrees on.
async function ensureMirror(owner, repo) {
  const dir = mirrorPath(owner, repo)
  if (await exists(path.join(dir, '.git'))) {
    await git(['fetch', 'origin', '--prune'], dir)
    return dir
  }
  await mkdir(REPOS_DIR, { recursive: true })
  // Use gh so auth/clone URL are handled for us.
  await run('gh', ['repo', 'clone', `${owner}/${repo}`, dir], { maxBuffer: 20 * 1024 * 1024 })
  return dir
}

// Create an isolated worktree + branch for a task. Returns { path, branch }.
export async function createWorktree(owner, repo, taskId, baseBranch) {
  const mirror = await ensureMirror(owner, repo)
  await mkdir(WORKTREES_DIR, { recursive: true })
  const branch = `squadron/${taskId}`
  const wt = worktreePath(taskId)
  const base = baseBranch || (await defaultBranch(mirror))
  await git(['worktree', 'add', '-b', branch, wt, `origin/${base}`], mirror)
  return { path: wt, branch, base, mirror }
}

// Detached worktree checked out at a PR's head, for read-only review context.
export async function createPrWorktree(owner, repo, taskId, prNumber) {
  const mirror = await ensureMirror(owner, repo)
  await mkdir(WORKTREES_DIR, { recursive: true })
  const wt = worktreePath(taskId)
  await git(['fetch', 'origin', `pull/${prNumber}/head`], mirror)
  await git(['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], mirror)
  return { path: wt }
}

async function defaultBranch(mirror) {
  try {
    const { stdout } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], mirror)
    return stdout.trim().replace('refs/remotes/origin/', '')
  } catch {
    return 'main'
  }
}

// The diff of a task's committed local changes vs. its base branch — what the
// agent produced, for review before pushing.
export async function taskDiff(taskId, base) {
  const wt = worktreePath(taskId)
  const b = base || 'main'
  const { stdout } = await git(['diff', `origin/${b}...HEAD`], wt)
  return stdout
}

// The repo's tracked files (gitignored paths excluded), for front-loading the
// planner so it doesn't discover structure one read at a time.
export async function trackedFiles(wt, limit = 400) {
  const { stdout } = await git(['ls-files'], wt)
  const all = stdout.split('\n').filter(Boolean)
  let list = all.slice(0, limit).join('\n')
  if (list.length > 12000) list = list.slice(0, 12000) + '\n…'
  return { total: all.length, shown: Math.min(all.length, limit), list }
}

// True if the agent actually changed anything.
export async function hasChanges(wt) {
  const { stdout } = await git(['status', '--porcelain'], wt)
  return stdout.trim().length > 0
}

// Stage + commit everything in the worktree. Returns true if a commit was made.
export async function commitAll(wt, message) {
  if (!(await hasChanges(wt))) return false
  await git(['add', '-A'], wt)
  await git(['commit', '-m', message], wt)
  return true
}

// Push the task branch to origin.
export async function pushBranch(wt, branch) {
  await git(['push', '-u', 'origin', branch], wt)
}

// Remove a worktree once we're done (branch stays on origin via the PR).
export async function removeWorktree(owner, repo, taskId) {
  const mirror = mirrorPath(owner, repo)
  const wt = worktreePath(taskId)
  if (await exists(wt)) {
    await git(['worktree', 'remove', wt, '--force'], mirror).catch(() => {})
  }
}
