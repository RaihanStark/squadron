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

// Display metadata for each CI state (badge styling + labels).
export const CI_LABEL = {
  success: { cls: 'ci-pass', text: '✓ CI passing', short: '✓ CI' },
  failure: { cls: 'ci-fail', text: '✗ CI failing', short: '✗ CI' },
  pending: { cls: 'ci-pending', text: '… CI pending', short: '… CI' },
  none: { cls: 'ci-none', text: 'no checks', short: '— CI' },
}
