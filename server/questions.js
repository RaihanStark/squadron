// Registry of in-flight clarification questions, keyed by taskId.
// When an agent calls the `ask_user` tool, its handler parks on the promise
// returned by register(); answer() (or clear()) resolves it.
const pending = new Map() // taskId -> resolve fn

export function register(taskId) {
  return new Promise((resolve) => pending.set(taskId, resolve))
}

export function answer(taskId, text) {
  const resolve = pending.get(taskId)
  if (!resolve) return false
  pending.delete(taskId)
  resolve(text)
  return true
}

// Unpark a waiting agent (e.g. on cancel) so it doesn't hang forever.
export function clear(taskId) {
  const resolve = pending.get(taskId)
  if (resolve) { pending.delete(taskId); resolve('(the operator cancelled this run)') }
}

export const isWaiting = (taskId) => pending.has(taskId)
