import { STATUS_LABEL } from '../constants.js'

export default function StatusBadge({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status] || status}</span>
}
