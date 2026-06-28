import { useEffect, useRef, useState } from 'react'
import { usePref } from '../prefs.js'
import { NOTIFY_PREFS, requestNotifyPermission } from '../notify.js'

// Header popover with a mute toggle per desktop-notification category (issue #32).
export default function NotifSettings() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const supported = typeof Notification !== 'undefined'
  const denied = supported && Notification.permission === 'denied'

  return (
    <div className="notif-settings" ref={ref}>
      <button className="notif-btn" title="Notification settings" onClick={() => { setOpen((o) => !o); requestNotifyPermission() }}>
        🔔
      </button>
      {open && (
        <div className="notif-popover">
          <div className="notif-head">Desktop notifications</div>
          {!supported && <div className="muted">Not available in this browser.</div>}
          {denied && <div className="muted">Blocked — enable notifications in your OS/browser settings.</div>}
          {NOTIFY_PREFS.map((p) => <NotifToggle key={p.key} pref={p} />)}
        </div>
      )}
    </div>
  )
}

function NotifToggle({ pref }) {
  const [on, setOn] = usePref(`notify.${pref.key}`, pref.fallback)
  return (
    <label className="notif-row">
      <input type="checkbox" checked={!!on} onChange={(e) => setOn(e.target.checked)} />
      <span>{pref.label}</span>
    </label>
  )
}
