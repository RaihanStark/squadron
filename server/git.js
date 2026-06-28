// Git + worktree management for agent runs.
//
// Model: for each repo we keep one "mirror" clone under data/repos/<owner>__<repo>.
// Every task gets its own branch + worktree under data/worktrees/<taskId>, so
// multiple agents can work the same repo in parallel without colliding.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const run = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.join(__dirname, '..', 'data')
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

async function defaultBranch(mirror) {
  try {
    const { stdout } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], mirror)
    return stdout.trim().replace('refs/remotes/origin/', '')
  } catch {
    return 'main'
  }
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
