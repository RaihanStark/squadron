import { useEffect, useState } from 'react'
import { api } from '../api.js'

// A thin status bar pinned to the foot of the window. Its bottom-right pill
// summarizes system readiness; click or hover it to reveal the individual
// checks — GitHub CLI auth and Claude Code install + Max/Pro subscription.
export default function StatusBar() {
  const [s, setS] = useState(null)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hover || pinned

  useEffect(() => {
    let alive = true
    const tick = () => api('/api/status').then((d) => alive && setS(d)).catch(() => {})
    tick()
    const id = setInterval(tick, 60_000) // refresh every minute
    return () => { alive = false; clearInterval(id) }
  }, [])

  const checks = s ? [
    {
      key: 'gh',
      label: 'GitHub CLI authenticated',
      ok: !!s.gh?.ok,
      detail: s.gh?.ok ? (s.gh.user ? `@${s.gh.user}` : 'authenticated') : s.gh?.error,
    },
    {
      key: 'claude',
      label: 'Claude Code installed · Max/Pro subscription',
      ok: !!s.claude?.ok,
      detail: s.claude?.ok ? (s.claude.plan || 'subscribed') : s.claude?.error,
    },
  ] : []

  const allOk = checks.length > 0 && checks.every((c) => c.ok)
  const tone = !s ? 'pending' : allOk ? 'ok' : 'warn'
  const summary = !s ? 'Checking…' : allOk ? 'All systems go' : 'Action needed'

  return (
    <footer className="statusbar">
      <div
        className="status-pill-wrap"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {open && checks.length > 0 && (
          <div className="status-popover">
            <div className="status-pop-head">System status</div>
            {checks.map((c) => (
              <div key={c.key} className="status-pop-row">
                <span className={`status-ico ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? '✓' : '✕'}</span>
                <span className="status-pop-label">{c.label}</span>
                {c.detail && <span className="status-pop-detail">{c.detail}</span>}
              </div>
            ))}
          </div>
        )}
        <button
          className={`status-pill ${tone}`}
          onClick={() => setPinned((p) => !p)}
          title="System status"
        >
          <span className={`status-dot ${tone}`} />
          {summary}
        </button>
      </div>
    </footer>
  )
}
