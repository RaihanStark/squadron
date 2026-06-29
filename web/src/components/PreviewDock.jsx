import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { usePref } from '../prefs.js'
import { parseAnsi } from '../ansi.js'

// A docked "Preview & Logs" panel: runs a worktree's dev server, streams its
// logs, and embeds any localhost URL it prints. Reused by a task's changes
// (`previewPath = /api/tasks/:id`) and an open PR (`/api/repos/:o/:r/pulls/:n`).
// `repoSlug` ("owner/name") scopes the per-repo run-command override.
export default function PreviewDock({ previewPath, repoSlug }) {
  const [preview, setPreview] = useState(null)
  const [cmd, setCmd] = useState('')
  const [cmdDirty, setCmdDirty] = useState(false)
  const [dockOpen, setDockOpen] = usePref('dockOpen', false)

  // Poll preview process state.
  useEffect(() => {
    let alive = true
    const poll = () => api(`${previewPath}/preview`).then((s) => { if (!alive) return; setPreview(s); setCmd((c) => (cmdDirty ? c : (s.command || ''))) }).catch(() => {})
    poll(); const i = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(i) }
  }, [previewPath, cmdDirty])

  const pStatus = preview?.status || 'stopped'
  const pRunning = ['preparing', 'starting', 'running'].includes(pStatus)

  async function startPreview() {
    if (cmdDirty) { await api(`/api/repos/${repoSlug}/run-command`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) }).catch(() => {}); setCmdDirty(false) }
    setDockOpen(true)
    await api(`${previewPath}/preview`, { method: 'POST' }).catch((e) => alert('Start failed: ' + e.message))
  }
  async function stopPreview() { await api(`${previewPath}/preview`, { method: 'DELETE' }).catch(() => {}) }

  return (
    <div className={`ide-dock ${dockOpen ? 'open' : ''}`}>
      <div className="dock-bar" onClick={() => setDockOpen((o) => !o)}>
        <span className="dock-title">{dockOpen ? '▾' : '▸'} Preview &amp; Logs</span>
        <span className="muted">{pRunning ? `running${preview?.url ? ` · ${preview.url}` : ''}` : pStatus}</span>
      </div>
      {dockOpen && (
        <div className="dock-body">
          <div className="preview-bar">
            <input className="cmd-input" value={cmd} placeholder="run command (e.g. npm run dev, go run .)" disabled={pRunning}
              onChange={(e) => { setCmd(e.target.value); setCmdDirty(true) }} />
            {preview?.source && !cmdDirty && <span className="muted">{preview.source}</span>}
            {pRunning ? <button className="cancel" onClick={stopPreview}>■ Stop</button> : <button className="approve-btn" onClick={startPreview}>▶ Start</button>}
            {preview?.url && <a className="dispatch" href={preview.url} target="_blank" rel="noreferrer">Open {preview.url} ↗</a>}
          </div>
          {pRunning && !preview?.url && <div className="muted preview-note">Running — no web URL detected. A desktop app (e.g. Go/Fyne) opens its window on your machine.</div>}
          {preview?.logs?.length ? (
            <div className="preview-logs">
              {preview.logs.slice(-300).map((line, i) => (
                <div key={i} className="log-row">{parseAnsi(line).map((s, j) => <span key={j} style={{ color: s.color || undefined, fontWeight: s.bold ? 700 : undefined }}>{s.text}</span>)}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
