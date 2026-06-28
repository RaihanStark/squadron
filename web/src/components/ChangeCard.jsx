import StatusBadge from './StatusBadge.jsx'

export default function ChangeCard({ task, onOpen }) {
  return (
    <div className="card card-click" onClick={onOpen}>
      <div className="card-main">
        {task.issueNumber ? <span className="num">#{task.issueNumber}</span> : <span className="num">⚡</span>}
        <span className="title">{task.issueTitle}</span>
      </div>
      <div className="card-meta">
        {task.branch && <span className="badge">{task.branch}</span>}
        {task.model && <span className="badge model-badge">{task.model}</span>}
        <StatusBadge status={task.status} />
        <span className="chev">Review changes →</span>
      </div>
    </div>
  )
}
