// Roll up a PR's `statusCheckRollup` into a single CI state for the UI.
// The rollup mixes CheckRun entries (have `status` + `conclusion`) and legacy
// StatusContext entries (have `state`). Returns one of:
//   'success' | 'failure' | 'pending' | 'none'

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const FAIL_STATES = new Set(['FAILURE', 'ERROR'])

export function ciState(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  let failure = false
  for (const c of rollup) {
    if (c.state != null) {
      // StatusContext (commit status)
      if (FAIL_STATES.has(c.state)) failure = true
      else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending = true
    } else {
      // CheckRun
      if (c.status !== 'COMPLETED') pending = true
      else if (FAIL_CONCLUSIONS.has(c.conclusion)) failure = true
    }
  }
  if (failure) return 'failure'
  if (pending) return 'pending'
  return 'success'
}

// Normalize each rollup entry into a flat { name, state, description, link } so
// the PR detail view can list every check and show which one failed.
export function ciChecks(rollup) {
  if (!Array.isArray(rollup)) return []
  return rollup.map((c) => {
    if (c.state != null) {
      // StatusContext (commit status)
      const state = FAIL_STATES.has(c.state) ? 'failure'
        : (c.state === 'PENDING' || c.state === 'EXPECTED') ? 'pending'
        : 'success'
      return { name: c.context || 'status', state, description: prettify(c.state), link: c.targetUrl || '' }
    }
    // CheckRun
    const state = c.status !== 'COMPLETED' ? 'pending'
      : FAIL_CONCLUSIONS.has(c.conclusion) ? 'failure'
      : 'success'
    const raw = c.status !== 'COMPLETED' ? c.status : c.conclusion
    return { name: c.name || c.workflowName || 'check', state, description: prettify(raw), link: c.detailsUrl || '' }
  })
}

function prettify(s) {
  return (s || '').toLowerCase().replace(/_/g, ' ')
}

// Display metadata for each CI state (badge styling + labels).
export const CI_LABEL = {
  success: { cls: 'ci-pass', text: '✓ CI passing', short: '✓ CI' },
  failure: { cls: 'ci-fail', text: '✗ CI failing', short: '✗ CI' },
  pending: { cls: 'ci-pending', text: '… CI pending', short: '… CI' },
  none: { cls: 'ci-none', text: 'no checks', short: '— CI' },
}

// Per-check icon for the detail breakdown.
export const CI_CHECK_SYMBOL = { success: '✓', failure: '✗', pending: '…' }
