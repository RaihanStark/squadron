import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { timeAgo } from '../constants.js'

// Suggest the next patch version from the latest tag. Only handles plain
// vX.Y.Z / X.Y.Z; anything fancier (pre-release suffixes etc.) is left blank for
// the user to type. First-ever release defaults to v0.1.0.
function suggestNext(tag) {
  if (!tag) return 'v0.1.0'
  const m = tag.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return ''
  const [, v, major, minor, patch] = m
  return `${v}${major}.${minor}.${Number(patch) + 1}`
}

// The Release tab: cut a tagged GitHub Release for the repo in one click. The
// pushed tag fires the repo's own release workflow (the exact thing that doesn't
// happen when you only bump a version field in a file).
export default function ReleasePanel({ repo, onReleaseTask }) {
  const [owner, name] = repo.nameWithOwner.split('/')
  const defaultBranch = repo.defaultBranchRef?.name || 'main'

  const [releases, setReleases] = useState(null)
  const [error, setError] = useState(null)
  const [tag, setTag] = useState('')
  const [target, setTarget] = useState(defaultBranch)
  const [notes, setNotes] = useState('')
  const [genNotes, setGenNotes] = useState(true)
  const [prerelease, setPrerelease] = useState(false)
  const [bumpVersion, setBumpVersion] = useState(true)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null)

  const load = () => api(`/api/repos/${owner}/${name}/releases`)
    .then((list) => {
      setReleases(list)
      setError(null)
      setTag((cur) => cur || suggestNext(list[0]?.tagName))
    })
    .catch((e) => setError(e.message))

  useEffect(() => {
    setReleases(null); setError(null); setCreated(null)
    setTag(''); setTarget(defaultBranch); setNotes(''); setGenNotes(true); setPrerelease(false); setBumpVersion(true)
    load()
  }, [repo.nameWithOwner])

  async function create() {
    const t = tag.trim()
    if (!t) return
    const tgt = target.trim() || defaultBranch
    const bumpLine = bumpVersion
      ? `\n\nAn AI agent will first bump the repo's version to match ${t} and push it to ${tgt}, then cut the release.`
      : ''
    if (!confirm(`Cut release ${t} on ${owner}/${name} (target: ${tgt})?\n\nThis pushes the ${t} tag and publishes a GitHub Release — triggering the repo's release workflow.${bumpLine}`)) return
    setBusy(true)
    try {
      const res = await api(`/api/repos/${owner}/${name}/releases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: t, target: target.trim(), notes, generateNotes: genNotes, prerelease, bumpVersion, defaultBranch }),
      })
      // With a version bump the release runs as an agent task — hand off to the
      // Agents view to watch it. Otherwise it's a one-shot { url } response.
      if (bumpVersion) {
        onReleaseTask?.(res)
        return
      }
      setCreated(res.url)
      setNotes('')
      load()
    } catch (e) { alert('Release failed: ' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="release">
      <div className="new-issue">
        <div className="release-head">🚀 Cut a new release</div>
        <p className="muted release-hint">
          Creates the tag and publishes a GitHub Release. Pushing the tag triggers this repo's
          release workflow (building &amp; attaching artifacts) — no manual <code>git tag</code> needed.
          With <em>Bump the version</em> on, an AI agent updates the repo's version manifests
          (e.g. <code>package.json</code>) to match the tag and pushes that to the target branch first,
          so the built artifact reports the right version.
        </p>
        <label className="release-field">
          <span>Tag</span>
          <input className="ni-title" placeholder="v1.2.0" value={tag} onChange={(e) => setTag(e.target.value)} />
        </label>
        <label className="release-field">
          <span>Target branch</span>
          <input className="ni-title" placeholder={defaultBranch} value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="release-check">
          <input type="checkbox" checked={bumpVersion} onChange={(e) => setBumpVersion(e.target.checked)} />
          Bump the version in the repo to match the tag (AI)
        </label>
        <label className="release-check">
          <input type="checkbox" checked={genNotes} onChange={(e) => setGenNotes(e.target.checked)} />
          Auto-generate release notes from commits
        </label>
        <textarea className="ni-body" placeholder="Additional release notes (markdown, optional)…" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <label className="release-check">
          <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
          Mark as pre-release
        </label>
        <div className="ni-actions">
          {created && <a className="link-btn" href={created} target="_blank" rel="noreferrer">View release ↗</a>}
          <button className="approve-btn" disabled={busy || !tag.trim()} onClick={create}>
            {busy ? 'Releasing…' : '🚀 Cut release'}
          </button>
        </div>
      </div>

      {error && <div className="error pad">⚠ {error}</div>}
      {created && <div className="log-result release-ok">✅ Released — the tag is pushed and the release workflow is on its way.</div>}

      {releases === null ? <div className="muted pad">Loading releases…</div>
        : !releases.length ? <div className="muted pad">No releases yet. Cut the first one above.</div>
        : releases.map((r) => (
          <a key={r.tagName} className="card card-click" href={`https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(r.tagName)}`} target="_blank" rel="noreferrer">
            <div className="card-main">
              <span className="title">{r.name || r.tagName}</span>
              {r.isLatest && <span className="label" style={{ '--c': 'var(--green)' }}>latest</span>}
              {r.isPrerelease && <span className="badge">pre-release</span>}
              {r.isDraft && <span className="badge">draft</span>}
              <span className="chev">↗</span>
            </div>
            <div className="card-meta">
              <span className="num">{r.tagName}</span>
              <span className="muted">{timeAgo(r.publishedAt || r.createdAt)}</span>
            </div>
          </a>
        ))}
    </div>
  )
}
