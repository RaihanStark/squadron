import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { ACTIVE, WORKING_LABEL } from '../constants.js'
import StatusBadge from './StatusBadge.jsx'
import Markdown from './Markdown.jsx'

export default function AgentDetail({ task, onOpenChanges }) {
  const logRef = useRef(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [approving, setApproving] = useState(false)
  const [, tick] = useState(0) // re-render every second while working, to tick the timer
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [task.events?.length, task.status])

  const workingLabel = WORKING_LABEL[task.status]
  useEffect(() => {
    if (!workingLabel) return
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [workingLabel])
  const lastTs = task.events?.length ? task.events[task.events.length - 1].ts : null
  const idleSecs = workingLabel && lastTs ? Math.max(0, Math.floor((Date.now() - lastTs) / 1000)) : 0

  async function post(path, body) {
    return api(`/api/tasks/${task.id}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  const waiting = task.status === 'waiting'     // execution paused on a question
  const planning = task.status === 'planning'   // planner is thinking
  const planned = task.status === 'planned'     // plan ready, awaiting you
  const reviewed = task.status === 'reviewed'   // review ready, awaiting you
  const canChat = planning || planned || waiting
  const busy = ACTIVE.has(task.status)

  async function send() {
    const text = reply.trim()
    if (!text) return
    setSending(true)
    try {
      await post(waiting ? 'answer' : 'message', { text }) // answer a question vs. refine the plan
      setReply('')
    } catch (e) { alert('Failed to send: ' + e.message) }
    finally { setSending(false) }
  }

  async function approve() {
    setApproving(true)
    try { await post('approve') } catch (e) { alert('Approve failed: ' + e.message) }
    finally { setApproving(false) }
  }

  const placeholder = waiting
    ? 'Answer the question — the agent is paused…'
    : 'Refine the plan — e.g. “use Argon2id, not the keyring” (⌘/Ctrl+Enter)'

  return (
    <>
      <div className="agent-head">
        <div>
          <h1>{task.owner}/{task.repo} {task.issueNumber ? <span className="muted">#{task.issueNumber}</span> : <span className="muted">⚡ quick task</span>}</h1>
          <div className="muted">{task.issueTitle}</div>
        </div>
        <div className="agent-actions">
          <StatusBadge status={task.status} />
          {task.model && <span className="badge model-badge">{task.model}</span>}
          {task.branch && <span className="badge">{task.branch}</span>}
          {busy && task.status !== 'changes_ready' && <button className="cancel" onClick={() => post('cancel')}>Cancel</button>}
          {task.status === 'changes_ready' && onOpenChanges && (
            <button className="approve-btn" onClick={() => onOpenChanges(task.id)}>Review changes →</button>
          )}
          {task.prUrl && <a className="dispatch" href={task.prUrl} target="_blank" rel="noreferrer">Open PR ↗</a>}
        </div>
      </div>

      {task.error && <div className="error pad">⚠ {task.error}</div>}

      <div className="log" ref={logRef}>
        {(task.events || []).map((e, i) => (
          <div key={i} className={`log-line log-${e.kind}`}>
            {e.kind === 'text' ? <Markdown className="log-text" text={e.text} />
              : e.kind === 'user' ? <span className="log-user">🧑 {e.text}</span>
              : e.kind === 'tool' ? <span className="log-tool">{e.text}</span>
              : e.kind === 'question' ? <span className="log-question">❓ {e.text}</span>
              : e.kind === 'answer' ? <span className="log-answer">↩︎ {e.text}</span>
              : e.kind === 'result' ? <span className="log-result">{e.ok ? '✅' : '⚠️'} {e.text}{e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ''}</span>
              : e.kind === 'error' ? <span className="log-err">⚠ {e.text}</span>
              : <span className="log-status">▸ {e.text}</span>}
          </div>
        ))}
        {workingLabel && (
          <div className="log-working">
            <span className="dots"><span /><span /><span /></span>
            {workingLabel}{idleSecs >= 3 ? ` · ${idleSecs}s` : ''}
          </div>
        )}
        {!task.events?.length && !workingLabel && <div className="muted">Waiting for the agent to report in…</div>}
      </div>

      {reviewed && (
        <div className="ask">
          <div className="approve-row">
            <span className="muted">Review ready. Approve to post it as a comment on the PR.</span>
            <button className="approve-btn" disabled={approving} onClick={approve}>
              {approving ? 'Posting…' : '✅ Approve & Post'}
            </button>
          </div>
        </div>
      )}

      {canChat && (
        <div className={`ask ${waiting ? 'ask-waiting' : ''}`}>
          {waiting && <div className="ask-q">❓ {task.question}</div>}
          {planned && (
            <div className="approve-row">
              <span className="muted">Plan ready. Refine it below, or send it to execution.</span>
              <button className="approve-btn" disabled={approving} onClick={approve}>
                {approving ? 'Dispatching…' : '✅ Approve & Dispatch'}
              </button>
            </div>
          )}
          <div className="ask-row">
            <textarea
              className="ask-input"
              placeholder={placeholder}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            />
            <button className="dispatch" disabled={sending || !reply.trim()} onClick={send}>
              {sending ? 'Sending…' : 'Send ↵'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
