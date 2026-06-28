// Small localStorage-backed preferences so UI state survives a browser refresh.
import { useState } from 'react'

const KEY = (k) => `squadron.${k}`

export function getPref(k, fallback) {
  try { const s = localStorage.getItem(KEY(k)); return s != null ? JSON.parse(s) : fallback } catch { return fallback }
}

export function setPref(k, v) {
  try { localStorage.setItem(KEY(k), JSON.stringify(v)) } catch { /* private mode / quota */ }
}

// useState that mirrors to localStorage. Supports functional updates.
export function usePref(k, fallback) {
  const [v, setV] = useState(() => getPref(k, fallback))
  const set = (nv) => setV((prev) => {
    const val = typeof nv === 'function' ? nv(prev) : nv
    setPref(k, val)
    return val
  })
  return [v, set]
}
