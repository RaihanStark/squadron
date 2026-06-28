// Thin wrappers over the `gh` CLI. Everything returns parsed JSON.
// Keeping GitHub access behind `gh` means we inherit the user's existing auth
// and never touch a token directly.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function gh(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 20 * 1024 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) : null
}

// Raw (non-JSON) gh call — returns trimmed stdout.
async function ghRaw(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 20 * 1024 * 1024 })
  return stdout.trim()
}

// The repos owned by / accessible to the authenticated user.
export function listRepos({ limit = 100 } = {}) {
  return gh([
    'repo', 'list',
    '--limit', String(limit),
    '--json', 'name,nameWithOwner,owner,description,updatedAt,isPrivate,isFork,stargazerCount,url,defaultBranchRef',
  ])
}

export function listIssues(owner, repo, { limit = 100 } = {}) {
  return gh([
    'issue', 'list',
    '--repo', `${owner}/${repo}`,
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,state,labels,updatedAt,createdAt,url,author,comments',
  ])
}

export function listPulls(owner, repo, { limit = 100 } = {}) {
  return gh([
    'pr', 'list',
    '--repo', `${owner}/${repo}`,
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,state,labels,updatedAt,createdAt,url,author,isDraft,reviewDecision,additions,deletions',
  ])
}

// Full detail (incl. body) for a single issue — used to brief the agent.
export function getIssue(owner, repo, number) {
  return gh([
    'issue', 'view', String(number),
    '--repo', `${owner}/${repo}`,
    '--json', 'number,title,body,labels,url',
  ])
}

// Open a PR for an already-pushed branch. Returns the PR URL.
export function createPr(owner, repo, { head, base, title, body }) {
  return ghRaw([
    'pr', 'create',
    '--repo', `${owner}/${repo}`,
    '--head', head,
    '--base', base,
    '--title', title,
    '--body', body,
  ]).then((out) => out.split('\n').filter(Boolean).pop())
}
