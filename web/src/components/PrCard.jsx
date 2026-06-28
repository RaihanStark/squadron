import StatusBadge from './StatusBadge.jsx'
import { ciState, CI_LABEL } from '../ci.js'

export default function PrCard({ pr, task, onOpenPr, cta }) {
  const ci = ciState(pr.statusCheckRollup)
  return (
    <div className="card card-click" onClick={onOpenPr}>
      <div className="card-main">
        <span className="num">#{pr.number}</span>
        <span className="title">{pr.title}</span>
      </div>
      <div className="card-meta">
        <span className="diff add">+{pr.additions}</span>
        <span className="diff del">−{pr.deletions}</span>
        {ci !== 'none' && <span className={`ci-badge ${CI_LABEL[ci].cls}`} title={CI_LABEL[ci].text}>{CI_LABEL[ci].short}</span>}
        {pr.isDraft && <span className="badge">draft</span>}
        {task?.findings?.length ? <span className="badge model-badge">{task.findings.length} finding(s)</span> : null}
        {task && task.status !== 'reviewed' && <StatusBadge status={task.status} />}
        <span className="chev">{cta}</span>
      </div>
    </div>
  )
}
