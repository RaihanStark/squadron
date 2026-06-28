import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { usePref } from '../prefs.js'
import { parseDiff } from '../diff.js'
import { parseAnsi } from '../ansi.js'
import DiffFile from './DiffFile.jsx'
import ChatLine from './ChatLine.jsx'
import StatusBadge from './StatusBadge.jsx'

export default function ChangesDetail({ task, onBack }) {
  const [files, setFiles] = useState(null)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [preview, setPreview] = useState(null)
  const [cmd, setCmd] = useState('')
  const [cmdDirty, setCmdDirty] = useState(false)
  const [chatText, setChatText] = useState('')
  const [sending, setSending] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [chatW, setChatW] = usePref('chatWidth', 400)
  const [dockOpen, setDockOpen] = usePref('dockOpen', false)
  const logRef = useRef(null)
  const dragging = useRef(false)

  // (Re)load the diff on open and whenever a revision finishes.
  useEffect(() => {
    setConfirmingDiscard(false)
    if (!task || ['pr_open', 'cancelled'].includes(task.status)) return
    api(`/api/tasks/${task.id}/diff`).then((r) => setFiles(parseDiff(r.diff || ''))).catch((e) => setError(e.message))
  }, [task?.id, task?.status])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [task?.events?.length, task?.status])

  // Poll preview process state.
  useEffect(() => {
    if (!task) return
    let alive = true
    const poll = () => api(`/api/tasks/${task.id}/preview`).then((s) => { if (!alive) return; setPreview(s); setCmd((c) => (cmdDirty ? c : (s.command || ''))) }).catch(() => {})
    poll(); const i = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(i) }
  }, [task?.id, cmdDirty])

  // Drag-to-resize the chat panel.
  useEffect(() => {
    const move = (e) => { if (dragging.current) setChatW(Math.max(300, Math.min(760, window.innerWidth - e.clientX))) }
    const up = () => { dragging.current = false; document.body.style.userSelect = '' }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  if (!task) return <div className="empty">These changes are no longer available.</div>

  const [owner, name] = `${task.owner}/${task.repo}`.split('/')
  const ready = task.status === 'changes_ready'
  const revising = ['preparing', 'running', 'committing'].includes(task.status)
  const waiting = task.status === 'waiting'
  const pStatus = preview?.status || 'stopped'
  const pRunning = ['preparing', 'starting', 'running'].includes(pStatus)

  async function push() {
    setPushing(true)
    try { await api(`/api/tasks/${task.id}/push`, { method: 'POST' }); onBack() }
    catch (e) { alert('Push failed: ' + e.message) } finally { setPushing(false) }
  }
  async function discard() {
    try { await api(`/api/tasks/${task.id}/cancel`, { method: 'POST' }); onBack() } catch (e) { alert(e.message) }
  }
  async function startPreview() {
    if (cmdDirty) { await api(`/api/repos/${owner}/${name}/run-command`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) }).catch(() => {}); setCmdDirty(false) }
    setDockOpen(true)
    await api(`/api/tasks/${task.id}/preview`, { method: 'POST' }).catch((e) => alert('Start failed: ' + e.message))
  }
  async function stopPreview() { await api(`/api/tasks/${task.id}/preview`, { method: 'DELETE' }).catch(() => {}) }
  async function stopRevise() { await api(`/api/tasks/${task.id}/stop`, { method: 'POST' }).catch(() => {}) }
  async function send() {
    const text = chatText.trim()
    if (!text) return
    setSending(true)
    try {
      if (waiting) await api(`/api/tasks/${task.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      else await api(`/api/tasks/${task.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: text }) })
      setChatText('')
    } catch (e) { alert('Failed: ' + e.message) } finally { setSending(false) }
  }

  return (
    <div className="ide">
      <div className="main-head pr-head ide-head">
        <div className="issue-head-main">
          <button className="link-btn" onClick={onBack}>← back</button>
          <h1>Changes for {task.issueNumber ? `#${task.issueNumber}` : 'quick task'} <span className="muted">{task.issueTitle}</span></h1>
        </div>
        <div className="agent-actions">
          <StatusBadge status={task.status} />
          {task.branch && <span className="badge">{task.branch}</span>}
          {ready && (confirmingDiscard ? (
            <>
              <span className="confirm-text">Discard changes &amp; worktree?</span>
              <button className="cancel" onClick={discard}>Confirm</button>
              <button className="link-btn" onClick={() => setConfirmingDiscard(false)}>Cancel</button>
            </>
          ) : (
            <button className="cancel" onClick={() => setConfirmingDiscard(true)}>Discard</button>
          ))}
          {ready && <button className="approve-btn" disabled={pushing} onClick={push}>{pushing ? 'Pushing…' : '⬆ Push & Open PR'}</button>}
          {task.prUrl && <a className="dispatch" href={task.prUrl} target="_blank" rel="noreferrer">Open PR ↗</a>}
        </div>
      </div>

      <div className="ide-body">
        <div className="ide-editor">
          {task.summary && <div className="review-summary">🤖 {task.summary}</div>}
          {error && <div className="error pad">⚠ {error}</div>}
          {files === null && !error && <div className="muted pad">Loading changes…</div>}
          {files && !files.length && <div className="muted pad">No changes in the working tree yet.</div>}
          {files && files.map((f, fi) => <DiffFile key={fi} file={f} findings={[]} />)}
        </div>

        <div className="ide-resize" onMouseDown={() => { dragging.current = true; document.body.style.userSelect = 'none' }} />

        <div className="ide-chat" style={{ width: chatW }}>
          <div className="chat-head">
            💬 Agent
            <span className={`status status-${revising ? 'running' : waiting ? 'waiting' : 'changes_ready'}`}>{revising ? 'working…' : waiting ? 'needs you' : 'idle'}</span>
          </div>
          <div className="chat-log" ref={logRef}>
            {(task.events || []).map((e, i) => <ChatLine key={i} e={e} />)}
            {!task.events?.length && <div className="muted">Ask the agent to change anything — it revises in this worktree and the diff updates on the left.</div>}
            {revising && <div className="log-working"><span className="dots"><span /><span /><span /></span>working…</div>}
          </div>
          {waiting && <div className="chat-q">❓ {task.question}</div>}
          <div className="chat-input">
            <textarea value={chatText} placeholder={waiting ? 'Answer the agent…' : 'Request changes — e.g. “add a test for empty rows”  (⌘/Ctrl+Enter)'}
              onChange={(e) => setChatText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
            <div className="chat-actions">
              {revising && !waiting && <button className="cancel" onClick={stopRevise}>■ Stop</button>}
              <button className="approve-btn" disabled={sending || !chatText.trim() || (revising && !waiting)} onClick={send}>
                {sending ? '…' : waiting ? 'Answer ↵' : 'Send ↵'}
              </button>
            </div>
          </div>
        </div>
      </div>

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
            {preview?.url && <iframe className="preview-frame" src={preview.url} title="preview" />}
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
    </div>
  )
}
