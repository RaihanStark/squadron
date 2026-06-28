// Minimal ANSI SGR parser → styled segments, so preview logs keep their colors.
const FG = {
  30: '#6e7681', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922', 34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 37: '#b1bac4',
  90: '#8b949e', 91: '#ffa198', 92: '#56d364', 93: '#e3b341', 94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc',
}

export function parseAnsi(str) {
  const out = []
  let cur = { color: null, bold: false }
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0
  let m
  const push = (t) => { if (t) out.push({ text: t, ...cur }) }
  while ((m = re.exec(str))) {
    push(str.slice(last, m.index))
    last = re.lastIndex
    const codes = (m[1] || '0').split(';').map((x) => (x === '' ? 0 : Number(x)))
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) cur = { color: null, bold: false }
      else if (c === 1) cur = { ...cur, bold: true }
      else if (c === 22) cur = { ...cur, bold: false }
      else if (c === 39) cur = { ...cur, color: null }
      else if (FG[c]) cur = { ...cur, color: FG[c] }
      else if (c === 38 && codes[i + 1] === 5) i += 2
      else if (c === 38 && codes[i + 1] === 2) i += 4
    }
  }
  push(str.slice(last))
  return out
}
