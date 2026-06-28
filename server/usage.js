// Reads the Claude subscription usage (the same numbers `/usage` shows in
// Claude Code) by calling the OAuth usage endpoint with the access token from
// the user's existing Claude Code login. Auth here mirrors agent.js: we never
// ask for an API key — we reuse ~/.claude/.credentials.json.
//
// The endpoint is undocumented and may change with Claude Code updates, so this
// module degrades gracefully: any failure returns { ok: false, error } rather
// than throwing, and the UI shows that instead of a crash.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const OAUTH_BETA = 'oauth-2025-04-20'

async function readToken() {
  const raw = JSON.parse(await readFile(CREDS, 'utf8'))
  const oauth = raw.claudeAiOauth
  if (!oauth?.accessToken) throw new Error('no Claude Code login found — run an agent or log in first')
  return oauth
}

async function call(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      'Content-Type': 'application/json',
    },
  })
  if (res.status === 401) throw new Error('login expired — run an agent or re-login to refresh the token')
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`)
  return res.json()
}

// Normalize one bucket from the API into { utilization, resetsAt } or null.
const bucket = (b) => (b && typeof b.utilization === 'number'
  ? { utilization: b.utilization, resetsAt: b.resets_at ?? null }
  : null)

// Returns the live usage snapshot. Shape:
//   { ok, plan, buckets: { fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet }, fetchedAt }
// or { ok: false, error } on any failure.
export async function get() {
  try {
    const { accessToken } = await readToken()
    const [usage, profile] = await Promise.all([
      call(USAGE_URL, accessToken),
      call(PROFILE_URL, accessToken).catch(() => null), // profile is a nicety, not required
    ])
    return {
      ok: true,
      plan: profile?.organization?.rate_limit_tier
        || (profile?.account?.has_claude_max ? 'claude_max' : profile?.account?.has_claude_pro ? 'claude_pro' : null),
      buckets: {
        fiveHour: bucket(usage.five_hour),
        sevenDay: bucket(usage.seven_day),
        sevenDayOpus: bucket(usage.seven_day_opus),
        sevenDaySonnet: bucket(usage.seven_day_sonnet),
      },
      fetchedAt: Date.now(),
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
