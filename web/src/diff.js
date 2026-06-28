// Parse a unified diff (from `gh pr diff`) into files → hunks → lines, tracking
// old/new line numbers so AI findings can be anchored to specific lines.
export function parseDiff(text) {
  const files = []
  let file = null
  let hunk = null
  let oldNum = 0
  let newNum = 0

  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('diff --git')) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/)
      file = { from: m?.[1] || null, to: m?.[2] || null, hunks: [] }
      files.push(file)
      hunk = null
    } else if (l.startsWith('--- ')) {
      if (file) file.from = l.slice(4).replace(/^a\//, '')
    } else if (l.startsWith('+++ ')) {
      if (file) file.to = l.slice(4).replace(/^b\//, '')
    } else if (l.startsWith('@@')) {
      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      if (m && file) {
        oldNum = parseInt(m[1], 10)
        newNum = parseInt(m[2], 10)
        hunk = { header: l.slice(0, l.indexOf('@@', 2) + 2), context: m[3].trim(), lines: [] }
        file.hunks.push(hunk)
      }
    } else if (hunk && (l[0] === '+' || l[0] === '-' || l[0] === ' ')) {
      const type = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
      const row = { type, text: l.slice(1), oldNum: null, newNum: null }
      if (type === 'add') row.newNum = newNum++
      else if (type === 'del') row.oldNum = oldNum++
      else { row.oldNum = oldNum++; row.newNum = newNum++ }
      hunk.lines.push(row)
    }
  }
  return files
}

export function filePath(f) {
  return f.to && f.to !== '/dev/null' ? f.to : f.from
}
