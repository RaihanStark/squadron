import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReview, commentableLines } from './runner.js'

test('normalizeReview coerces field types and keeps a numeric line', () => {
  const r = normalizeReview({
    summary: '  looks ok  ',
    findings: [{ file: 'a.js', line: '12', severity: 'bug', body: 'off-by-one' }],
  })
  assert.equal(r.summary, 'looks ok')
  assert.deepEqual(r.findings, [{ file: 'a.js', line: 12, severity: 'bug', body: 'off-by-one' }])
})

test('normalizeReview maps a non-numeric line to null and defaults severity', () => {
  const r = normalizeReview({ findings: [{ file: 'a.js', line: 'nope', body: 'x' }] })
  assert.equal(r.summary, '')
  assert.equal(r.findings[0].line, null)
  assert.equal(r.findings[0].severity, 'quality')
})

test('normalizeReview tolerates missing or non-array findings', () => {
  assert.deepEqual(normalizeReview({ summary: 'hi' }), { summary: 'hi', findings: [] })
  assert.deepEqual(normalizeReview({ findings: 'oops' }), { summary: '', findings: [] })
  assert.deepEqual(normalizeReview(), { summary: '', findings: [] })
})

test('commentableLines collects RIGHT-side line numbers, skipping deletions', () => {
  const diff = [
    'diff --git a/foo.js b/foo.js',
    '--- a/foo.js',
    '+++ b/foo.js',
    '@@ -1,2 +1,3 @@',
    ' const a = 1',   // context  -> line 1
    '-const b = 2',   // deletion -> no new-file line
    '+const b = 3',   // added    -> line 2
    '+const c = 4',   // added    -> line 3
  ].join('\n')
  const map = commentableLines(diff)
  assert.deepEqual([...map['foo.js']].sort((a, b) => a - b), [1, 2, 3])
})
