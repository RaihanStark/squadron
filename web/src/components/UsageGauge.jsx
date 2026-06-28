import { useEffect, useState } from 'react'
import { api } from '../api.js'

// "resets in 2h 10m" / "resets in 3d" from an ISO timestamp.
function resetsIn(iso) {
  if (!iso) return ''
  const ms = new Date(iso) - Date.now()
  if (ms <= 0) return 'resetting…'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `resets in ${hrs}h ${mins % 60}m`
  return `resets in ${Math.round(hrs / 24)}d`
}

// Color shifts as a window fills up: green → amber → red.
const tone = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok')

function Bar({ label, b }) {
  if (!b) return null
  const pct = Math.min(100, Math.round(b.utilization))
  return (
    <div className="usage-bar" title={`${pct}% used · ${resetsIn(b.resetsAt)}`}>
      <div className="usage-bar-top">
        <span className="usage-label">{label}</span>
        <span className={`usage-pct ${tone(pct)}`}>{pct}%</span>
      </div>
      <div className="usage-track"><div className={`usage-fill ${tone(pct)}`} style={{ width: `${pct}%` }} /></div>
      <span className="usage-reset">{resetsIn(b.resetsAt)}</span>
    </div>
  )
}

// Live Claude subscription usage, polled from /api/usage. Sits at the foot of
// the sidebar so you can see remaining headroom before dispatching an agent.
export default function UsageGauge() {
  const [u, setU] = useState(null)

  useEffect(() => {
    let alive = true
    const tick = () => api('/api/usage').then((d) => alive && setU(d)).catch(() => {})
    tick()
    const id = setInterval(tick, 5 * 60_000) // refresh every 5 minutes (60 s was too frequent for the rate-limited OAuth endpoint)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!u) return null
  if (!u.ok) {
    return (
      <div className="usage" title={u.error}>
        <div className="usage-head">USAGE</div>
        <div className="usage-err">⚠ {u.error}</div>
      </div>
    )
  }

  const { fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet } = u.buckets
  return (
    <div className="usage">
      <div className="usage-head">USAGE{u.plan ? ` · ${u.plan.replace(/_/g, ' ')}` : ''}</div>
      <Bar label="5-hour" b={fiveHour} />
      <Bar label="Weekly" b={sevenDay} />
      <Bar label="Weekly · Opus" b={sevenDayOpus} />
      <Bar label="Weekly · Sonnet" b={sevenDaySonnet} />
    </div>
  )
}
