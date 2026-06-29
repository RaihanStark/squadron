// System status checks shown in the bottom status bar:
//   1. Is the GitHub CLI (`gh`) authenticated?
//   2. Is Claude Code installed (logged in) with a Max/Pro subscription?
//
// Both checks degrade gracefully — any failure returns { ok: false, error }
// rather than throwing, so the status bar can render the problem.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const CREDS = path.join(os.homedir(), '.claude', '.credentials.json')
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const OAUTH_BETA = 'oauth-2025-04-20'

// `gh auth status` exits 0 when logged in (writing its report to stderr) and
// non-zero otherwise — execFile rejects on the non-zero exit.
async function ghStatus() {
  try {
    const { stdout, stderr } = await run('gh', ['auth', 'status'])
    const text = `${stdout}\n${stderr}`
    const m = text.match(/account\s+(\S+)/i)
    return { ok: true, user: m?.[1] || null }
  } catch {
    return { ok: false, error: 'not logged in — run `gh auth login`' }
  }
}

// Normalize the various plan identifiers the profile endpoint can return into a
// short label, and whether it counts as a Max/Pro subscription.
function planLabel(plan) {
  if (!plan) return null
  return String(plan).replace(/^claude[_-]?/i, '').replace(/_/g, ' ').trim() || null
}

// Claude Code stores its OAuth login in ~/.claude/.credentials.json once you've
// logged in, so its presence means Claude Code is installed. We then confirm a
// Max/Pro subscription via the same profile endpoint the usage gauge uses.
async function claudeStatus() {
  let oauth
  try {
    const raw = JSON.parse(await readFile(CREDS, 'utf8'))
    oauth = raw.claudeAiOauth
  } catch {
    // file missing or unreadable
  }
  if (!oauth?.accessToken) {
    return { ok: false, installed: false, error: 'Claude Code login not found — run `claude` and log in' }
  }
  let plan = null
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': OAUTH_BETA, 'Content-Type': 'application/json' },
    })
    if (res.ok) {
      const profile = await res.json()
      plan = profile?.account?.has_claude_max ? 'claude_max'
        : profile?.account?.has_claude_pro ? 'claude_pro'
        : (profile?.organization?.rate_limit_tier || null)
    }
  } catch {
    // network/profile failure — fall through; we still know it's installed
  }
  const label = planLabel(plan)
  const subscribed = !!plan && /max|pro/i.test(plan)
  return {
    ok: subscribed,
    installed: true,
    plan: label,
    error: subscribed ? null : (plan ? null : 'could not confirm a Max or Pro subscription'),
  }
}

// One snapshot for the status bar: { gh, claude }.
export async function get() {
  const [gh, claude] = await Promise.all([ghStatus(), claudeStatus()])
  return { gh, claude }
}
