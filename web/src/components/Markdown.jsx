// A tiny, dependency-free Markdown → React renderer. Just enough to make
// agent plans and summaries readable: headings, bold/italic/inline code,
// links, ordered/unordered lists, fenced code blocks, blockquotes and rules.
// Deliberately small — we keep the web bundle dep-free (see web/package.json).

// Inline: split a line into styled spans (code, bold, italic, links).
function inline(text, keyPrefix) {
  const out = []
  let i = 0
  let k = 0
  const push = (node) => out.push(node)
  // Earliest-match tokenizer over the supported inline patterns.
  const patterns = [
    { re: /`([^`]+)`/, render: (m, key) => <code key={key} className="md-code">{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/, render: (m, key) => <strong key={key}>{inline(m[1], key)}</strong> },
    { re: /__([^_]+)__/, render: (m, key) => <strong key={key}>{inline(m[1], key)}</strong> },
    { re: /\*([^*]+)\*/, render: (m, key) => <em key={key}>{inline(m[1], key)}</em> },
    { re: /_([^_]+)_/, render: (m, key) => <em key={key}>{inline(m[1], key)}</em> },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, render: (m, key) => <a key={key} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a> },
  ]
  while (i < text.length) {
    let best = null
    for (const p of patterns) {
      const m = p.re.exec(text.slice(i))
      if (m && (!best || m.index < best.m.index)) best = { p, m }
    }
    if (!best) { push(text.slice(i)); break }
    if (best.m.index > 0) push(text.slice(i, i + best.m.index))
    push(best.p.render(best.m, `${keyPrefix}-i${k++}`))
    i += best.m.index + best.m[0].length
  }
  return out
}

// Block-level parse into an array of React elements.
function blocks(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const nodes = []
  let i = 0
  let k = 0
  const key = () => `b${k++}`

  while (i < lines.length) {
    const line = lines[i]

    // Blank line — skip.
    if (!line.trim()) { i++; continue }

    // Fenced code block.
    const fence = line.match(/^\s*```(.*)$/)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // closing fence
      nodes.push(<pre key={key()} className="md-pre"><code>{body.join('\n')}</code></pre>)
      continue
    }

    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const Tag = `h${h[1].length}`
      nodes.push(<Tag key={key()} className="md-h">{inline(h[2], key())}</Tag>)
      i++
      continue
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      nodes.push(<hr key={key()} className="md-hr" />)
      i++
      continue
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      nodes.push(<blockquote key={key()} className="md-quote">{blocks(body.join('\n'))}</blockquote>)
      continue
    }

    // Lists (ordered or unordered).
    const isUl = (l) => /^\s*[-*+]\s+/.test(l)
    const isOl = (l) => /^\s*\d+[.)]\s+/.test(l)
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line)
      const items = []
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        const text = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '')
        items.push(<li key={key()}>{inline(text, key())}</li>)
        i++
      }
      const Tag = ordered ? 'ol' : 'ul'
      nodes.push(<Tag key={key()} className="md-list">{items}</Tag>)
      continue
    }

    // Paragraph — gather consecutive non-blank, non-block lines.
    const para = [line]
    i++
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
    ) { para.push(lines[i]); i++ }
    nodes.push(<p key={key()} className="md-p">{inline(para.join('\n'), key())}</p>)
  }

  return nodes
}

export default function Markdown({ text, className = '' }) {
  return <div className={`md ${className}`.trim()}>{blocks(text || '')}</div>
}
