// Thin wrappers over the `gh` CLI. Everything returns parsed JSON.
// Keeping GitHub access behind `gh` means we inherit the user's existing auth
// and never touch a token directly.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Run `gh` with a JSON body piped to stdin (for `gh api --input -`).
function ghStdin(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || `gh exited ${code}`).trim()))))
    p.stdin.write(input)
    p.stdin.end()
  })
}

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

// Metadata for a single repo ("owner/name"). One `gh` call; run in parallel
// across the curated set instead of listing the user's whole fleet.
export function getRepo(nameWithOwner) {
  return gh([
    'repo', 'view', nameWithOwner,
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
    '--json', 'number,title,state,labels,updatedAt,createdAt,url,author,isDraft,reviewDecision,additions,deletions,statusCheckRollup',
  ])
}

// The authenticated GitHub login.
export function currentUser() {
  return ghRaw(['api', 'user', '--jq', '.login'])
}

// Create a GitHub issue. Returns the issue URL.
export function createIssue(owner, repo, { title, body }) {
  return ghRaw(['issue', 'create', '--repo', `${owner}/${repo}`, '--title', title, '--body', body || ''])
}

// Edit a GitHub issue's title and/or body.
export function editIssue(owner, repo, number, { title, body }) {
  const args = ['issue', 'edit', String(number), '--repo', `${owner}/${repo}`]
  if (title != null) args.push('--title', title)
  if (body != null) args.push('--body', body)
  return ghRaw(args)
}

// Full detail (incl. body) for a single issue — used to brief the agent.
export function getIssue(owner, repo, number) {
  return gh([
    'issue', 'view', String(number),
    '--repo', `${owner}/${repo}`,
    '--json', 'number,title,body,labels,url,author',
  ])
}

// Full detail for a single PR (incl. head/base refs + CI/merge state) — used to
// set up a review and to gate the merge button.
export function getPr(owner, repo, number) {
  return gh([
    'pr', 'view', String(number),
    '--repo', `${owner}/${repo}`,
    '--json', 'number,title,body,headRefName,baseRefName,url,additions,deletions,isDraft,mergeable,mergeStateStatus,statusCheckRollup',
  ])
}

// Merge a PR via `gh pr merge`. method is one of squash|merge|rebase.
// GitHub rejects the merge if CI/branch-protection isn't satisfied — that error
// surfaces to the caller unchanged.
export function mergePr(owner, repo, number, { method = 'squash' } = {}) {
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[method] || '--squash'
  return ghRaw(['pr', 'merge', String(number), '--repo', `${owner}/${repo}`, flag])
}

// The unified diff for a PR.
export function getPrDiff(owner, repo, number) {
  return ghRaw(['pr', 'diff', String(number), '--repo', `${owner}/${repo}`])
}

// Post a comment on a PR. Returns the comment URL.
export function postPrComment(owner, repo, number, body) {
  return ghRaw(['pr', 'comment', String(number), '--repo', `${owner}/${repo}`, '--body', body])
}

// Create a PR review with optional inline comments via the Reviews API.
// payload: { body, event: 'COMMENT', comments: [{ path, line, side, body }] }
// Returns the review's html_url.
export async function postPrReview(owner, repo, number, payload) {
  const out = await ghStdin(
    ['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'],
    JSON.stringify(payload),
  )
  const res = JSON.parse(out)
  return res.html_url || ''
}

// Recent releases for a repo — powers the Release tab + next-version suggestion.
export function listReleases(owner, repo, { limit = 20 } = {}) {
  return gh([
    'release', 'list',
    '--repo', `${owner}/${repo}`,
    '--limit', String(limit),
    '--json', 'tagName,name,isLatest,isPrerelease,isDraft,publishedAt,createdAt',
  ])
}

// Cut a new release: creates the git tag (which fires any `on: push: tags`
// workflow in the repo) and publishes a GitHub Release. Returns the release URL.
// We always pass either --generate-notes or --notes so `gh` never drops into an
// interactive editor in this server context.
export function createRelease(owner, repo, { tag, target, title, notes, generateNotes, prerelease, draft } = {}) {
  const args = ['release', 'create', tag, '--repo', `${owner}/${repo}`]
  if (target) args.push('--target', target)
  if (title) args.push('--title', title)
  if (prerelease) args.push('--prerelease')
  if (draft) args.push('--draft')
  if (generateNotes) args.push('--generate-notes')
  if (notes) args.push('--notes', notes)
  if (!generateNotes && !notes) args.push('--notes', '')
  return ghRaw(args).then((out) => out.split('\n').filter(Boolean).pop())
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
