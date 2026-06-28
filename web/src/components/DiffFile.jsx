import { Fragment } from 'react'
import { filePath } from '../diff.js'

export function FindingCard({ f, unanchored }) {
  return (
    <div className={`finding sev-${f.severity}`}>
      <div className="finding-head">
        🤖 <span className="finding-sev">{f.severity}</span>
        {unanchored && f.line ? <span className="muted"> · line {f.line} (not in shown diff)</span> : null}
      </div>
      <div className="finding-body">{f.body}</div>
    </div>
  )
}

export default function DiffFile({ file, findings }) {
  const placed = new Set()
  return (
    <div className="diff-file">
      <div className="diff-file-head">{filePath(file)}</div>
      {!file.hunks.length && <div className="diff-empty">No textual diff (binary, rename, or mode change).</div>}
      {file.hunks.map((h, hi) => (
        <div className="diff-hunk" key={hi}>
          <div className="diff-line diff-hunkhead"><span className="ln" /><span className="ln" /><span className="diff-code">{h.header} {h.context}</span></div>
          {h.lines.map((ln, li) => {
            const here = findings.filter((fd) => fd.line != null && fd.line === ln.newNum)
            here.forEach((fd) => placed.add(fd))
            return (
              <Fragment key={li}>
                <div className={`diff-line diff-${ln.type}`}>
                  <span className="ln">{ln.oldNum ?? ''}</span>
                  <span className="ln">{ln.newNum ?? ''}</span>
                  <span className="diff-code">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}{ln.text}</span>
                </div>
                {here.map((fd, k) => <FindingCard key={k} f={fd} />)}
              </Fragment>
            )
          })}
        </div>
      ))}
      {findings.filter((fd) => !placed.has(fd)).map((fd, k) => <FindingCard key={`u${k}`} f={fd} unanchored />)}
    </div>
  )
}
