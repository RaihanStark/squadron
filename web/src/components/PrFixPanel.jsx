import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import Markdown from './Markdown.jsx'
import StatusBadge from './StatusBadge.jsx'

// Statuses where a PR-fix owns a live, warm session (chat is active).
const LIVE = new Set(['queued', 'preparing', 'running', 'errand_idle', 'waiting', 'committing'])

// A docked "quick fix" sidebar scoped to one open PR. Same warm chat loop as the
// repo Quick task, but the worktree is the PR's head branch — so the staged
// changes push back to update the PR itself (handy for reviewer feedback).
export default function PrFixPanel({ repo, pr, tasks, onStartFix, onOpenChanges, onClose }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [composing, setComposing] = useState(false) // force the launcher even when a finished fix lingers
  const logRef = useRef(null)

  const fixes = tasks
    .filter((t) => t.kind === 'pr_fix' && `${t.owner}/${t.repo}` === repo.nameWithOwner && t.issueNumber === pr.number)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const live = fixes.find((t) => LIVE.has(t.status))
  const recent = fixes[0]
  const staged = !live && recent && recent.status === 'changes_ready'

  const showChat = !!live
  const showStaged = !showChat && staged && !composing
  const showLauncher = !showChat && !showStaged

  // Fresh PR → reset the composer.
  useEffect(() => { setComposing(false); setText('') }, [repo.nameWithOwner, pr.number])
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [live?.events?.length, live?.status, live?.streaming])

  const idle = live?.status === 'errand_idle'
  const waiting = live?.status === 'waiting'
  const working = showChat && !idle && !waiting

  async function post(path, body) {
    return api(`/api/tasks/${live.id}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  async function start() {
    const t = text.trim()
    if (!t) return
    setBusy(true)
    try { await onStartFix(repo, pr, t); setText(''); setComposing(false) }
    catch (e) { alert('Failed to start: ' + e.message) }
    finally { setBusy(false) }
  }

  async function send() {
    const t = text.trim()
    if (!t) return
    setBusy(true)
    try { await post(waiting ? 'answer' : 'message', { text: t }); setText('') }
    catch (e) { alert('Failed to send: ' + e.message) }
    finally { setBusy(false) }
  }

  async function stage() {
    setBusy(true)
    try { await post('stage') } catch (e) { alert('Stage failed: ' + e.message) } finally { setBusy(false) }
  }

  async function discard() {
    if (!confirm('Discard this quick fix? This removes the worktree.')) return
    try { await post('cancel') } catch (e) { alert(e.message) }
  }

  const onEnter = (fn) => (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) fn() }

  return (
    <aside className="repo-chat">
      <div className="repo-chat-head">
        <span>🔧 Fix PR #{pr.number}</span>
        {showChat ? <StatusBadge status={live.status} /> : <button className="link-btn" onClick={onClose}>close</button>}
      </div>

      {showLauncher && (
        <div className="repo-chat-launch">
          <p className="muted">Adjust this PR without leaving Squadron — the agent works on the PR's branch and your staged changes push back to update it. Handy for addressing a reviewer's feedback from GitHub.</p>
          <textarea
            className="ask-input"
            placeholder="Tell the agent what to change on this PR — e.g. “address the review comment about null handling in api.js”  (⌘/Ctrl+Enter)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onEnter(start)}
          />
          <button className="dispatch" disabled={busy || !text.trim()} onClick={start}>
            {busy ? 'Starting…' : 'Update PR ↵'}
          </button>
        </div>
      )}

      {showStaged && (
        <div className="repo-chat-launch">
          <div className="log-result">✅ Changes staged — review, then push to update the PR.</div>
          <button className="approve-btn" onClick={() => onOpenChanges(recent.id)}>Review changes →</button>
          <button className="dispatch view-btn" onClick={() => setComposing(true)}>+ New fix</button>
        </div>
      )}

      {showChat && (
        <>
          <div className="log" ref={logRef}>
            {(live.events || []).map((e, i) => (
              <div key={i} className={`log-line log-${e.kind}`}>
                {e.kind === 'text' ? <Markdown className="log-text" text={e.text} />
                  : e.kind === 'user' ? <span className="log-user">🧑 {e.text}</span>
                  : e.kind === 'tool' ? <span className="log-tool">{e.text}</span>
                  : e.kind === 'question' ? <span className="log-question">❓ {e.text}</span>
                  : e.kind === 'answer' ? <span className="log-answer">↩︎ {e.text}</span>
                  : e.kind === 'result' ? <span className="log-result">{e.ok ? '✅' : '⚠️'} {e.text}</span>
                  : e.kind === 'error' ? <span className="log-err">⚠ {e.text}</span>
                  : <span className="log-status">▸ {e.text}</span>}
              </div>
            ))}
            {live.streaming && (
              <div className="log-line log-text streaming"><Markdown className="log-text" text={live.streaming} /></div>
            )}
            {working && <div className="log-working"><span className="dots"><span /><span /><span /></span>agent working…</div>}
            {!live.events?.length && !working && <div className="muted">Waiting for the agent to report in…</div>}
          </div>

          <div className={`ask ${waiting ? 'ask-waiting' : ''}`}>
            {waiting && <div className="ask-q">❓ {live.question}</div>}
            <div className="ask-row">
              <textarea
                className="ask-input"
                placeholder={waiting ? 'Answer the agent…' : 'Refine it — e.g. “also update the test”  (⌘/Ctrl+Enter)'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onEnter(send)}
              />
              <button className="dispatch" disabled={busy || !text.trim() || working} onClick={send}>
                {busy ? '…' : waiting ? 'Answer ↵' : 'Send ↵'}
              </button>
            </div>
            <div className="repo-chat-actions">
              <button className="cancel" onClick={discard}>Discard</button>
              <button className="approve-btn" disabled={busy || working || waiting} title={working || waiting ? 'Wait for the agent to finish this turn' : ''} onClick={stage}>
                ✅ Stage for review
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
