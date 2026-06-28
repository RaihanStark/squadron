import Markdown from './Markdown.jsx'

export default function ChatLine({ e }) {
  if (e.kind === 'user') return <div className="chat-msg chat-user">{e.text}</div>
  if (e.kind === 'question') return <div className="chat-msg chat-agent">❓ {e.text}</div>
  if (e.kind === 'answer') return <div className="chat-msg chat-user">↩︎ {e.text}</div>
  if (e.kind === 'text') return <div className="chat-msg chat-agent"><Markdown text={e.text} /></div>
  if (e.kind === 'tool') return <div className="chat-tool">{e.text}</div>
  if (e.kind === 'result') return <div className="chat-result">{e.ok ? '✅' : '⚠️'} {e.text}</div>
  if (e.kind === 'error') return <div className="chat-err">⚠ {e.text}</div>
  return <div className="chat-status">▸ {e.text}</div>
}
