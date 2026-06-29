// Deterministic demo data for screenshots / first-run preview.
// Activated by loading the app with ?demo (optionally &view=agents).
// Nothing here touches a real repo or the backend.

const now = Date.UTC(2026, 5, 28, 9, 0, 0)
const ago = (mins) => new Date(now - mins * 60000).toISOString()

export const repos = [
  { name: 'financy', nameWithOwner: 'acme/financy', isPrivate: false, updatedAt: ago(12), defaultBranchRef: { name: 'main' } },
  { name: 'timetracky', nameWithOwner: 'acme/timetracky', isPrivate: false, updatedAt: ago(40), defaultBranchRef: { name: 'main' } },
  { name: 'vault-keep', nameWithOwner: 'acme/vault-keep', isPrivate: true, updatedAt: ago(180), defaultBranchRef: { name: 'main' } },
  { name: 'pomodoro-cli', nameWithOwner: 'acme/pomodoro-cli', isPrivate: false, updatedAt: ago(1500), defaultBranchRef: { name: 'main' } },
  { name: 'markdown-notes', nameWithOwner: 'acme/markdown-notes', isPrivate: false, updatedAt: ago(4200), defaultBranchRef: { name: 'main' } },
]

// The full fleet the "Add repo" picker would browse (a superset of the curated
// `repos` above). Only fetched on demand via /api/repos/all.
export const allRepos = [
  ...repos,
  { name: 'design-system', nameWithOwner: 'acme/design-system', owner: { login: 'acme' }, isPrivate: false, updatedAt: ago(90), defaultBranchRef: { name: 'main' } },
  { name: 'infra', nameWithOwner: 'acme/infra', owner: { login: 'acme' }, isPrivate: true, updatedAt: ago(600), defaultBranchRef: { name: 'main' } },
  { name: 'docs-site', nameWithOwner: 'acme/docs-site', owner: { login: 'acme' }, isPrivate: false, updatedAt: ago(3000), defaultBranchRef: { name: 'main' } },
]

const L = (name, color) => ({ name, color })

export const issuesByRepo = {
  'acme/financy': [
    { id: 'Ldemo1', local: true, number: null, title: 'Dark-mode toggle in settings', labels: [], comments: 0, updatedAt: ago(5), url: null, body: 'Add a toggle in Settings to switch between light and dark themes, persisted to the config file. (Drafted locally in Squadron — not yet on GitHub.)' },
    { number: 3, title: 'Add password encryption for the local vault', labels: [L('enhancement', '3fb950'), L('security', 'd73a4a')], comments: 4, updatedAt: ago(60), url: '#' },
    { number: 22, title: 'Release to Flathub', labels: [L('packaging', '0e8a16')], comments: 1, updatedAt: ago(220), url: '#' },
    { number: 31, title: 'Dark mode flickers on startup', labels: [L('bug', 'd73a4a'), L('ui', 'a2eeef')], comments: 2, updatedAt: ago(900), url: '#' },
    { number: 35, title: 'Add CSV import for transactions', labels: [L('enhancement', '3fb950')], comments: 0, updatedAt: ago(2600), url: '#' },
  ],
  'acme/timetracky': [
    { number: 14, title: 'Export tracked hours to CSV', labels: [L('enhancement', '3fb950')], comments: 3, updatedAt: ago(45), url: '#' },
    { number: 18, title: 'Idle detection stops timer too aggressively', labels: [L('bug', 'd73a4a')], comments: 5, updatedAt: ago(1300), url: '#' },
  ],
}

export const pullsByRepo = {
  'acme/financy': [
    { number: 40, title: 'Release to Flathub', labels: [L('packaging', '0e8a16')], isDraft: false, reviewDecision: 'REVIEW_REQUIRED', additions: 213, deletions: 18, updatedAt: ago(20), url: '#', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'build', detailsUrl: '#' }, { status: 'COMPLETED', conclusion: 'FAILURE', name: 'test', detailsUrl: '#' }, { status: 'IN_PROGRESS', name: 'lint', detailsUrl: '#' }] },
  ],
  'acme/timetracky': [],
}

export const tasks = [
  {
    id: 'twait', owner: 'acme', repo: 'financy', issueNumber: 3,
    issueTitle: 'Add password encryption for the local vault',
    status: 'planned', branch: 'squadron/twait', base: 'main', prUrl: null, model: 'opus',
    costUsd: null, createdAt: now - 4 * 60000,
    plan: 'Encrypt the vault at rest with an Argon2id-derived key, prompting for a passphrase on unlock.',
    events: [
      { kind: 'status', text: 'planner online · claude-opus-4-8' },
      { kind: 'tool', text: '📖 read README.md' },
      { kind: 'tool', text: '📖 read src/vault/store.js' },
      { kind: 'tool', text: '🔍 grep "writeFileSync"' },
      { kind: 'text', text: 'Here is the plan:\n\n1. Add src/vault/crypto.js — Argon2id KDF + AES-256-GCM encrypt/decrypt helpers.\n2. store.js: encrypt on save(), decrypt on load(); store salt+nonce in the file header.\n3. Prompt for a passphrase on unlock (cli/unlock.js); cache the derived key in memory for the session.\n4. Migration: detect legacy plaintext vaults on first load and re-encrypt transparently.\n5. Tests for round-trip encrypt/decrypt and the plaintext→encrypted migration.' },
      { kind: 'user', text: 'Good. Use Argon2id (not scrypt), and make sure the migration is reversible with `--export-plaintext`.' },
      { kind: 'text', text: 'Updated: KDF is Argon2id with sane defaults (m=64MB, t=3). Added an `--export-plaintext` escape hatch that decrypts back to the legacy format. Ready when you are.' },
    ],
  },
  {
    id: 'trun', owner: 'acme', repo: 'timetracky', issueNumber: 14,
    issueTitle: 'Export tracked hours to CSV',
    status: 'running', branch: 'squadron/trun', base: 'main', prUrl: null, model: 'sonnet',
    costUsd: null, createdAt: now - 2 * 60000,
    plan: 'Add a toCSV() serializer behind `export --format csv`.',
    events: [
      { kind: 'status', text: 'Plan approved — starting execution…' },
      { kind: 'status', text: 'executing · claude-sonnet-4-6' },
      { kind: 'tool', text: '📖 read src/export.js' },
      { kind: 'tool', text: '✏️  edit src/export.js' },
      { kind: 'tool', text: '📝 write src/export.csv.test.js' },
      { kind: 'tool', text: '$ npm test -- export' },
      { kind: 'text', text: 'Added a toCSV() serializer and wired it to the `export --format csv` flag. Writing a test for the rounding of partial hours.' },
    ],
  },
  {
    id: 'tdone', owner: 'acme', repo: 'financy', issueNumber: 22,
    issueTitle: 'Release to Flathub',
    status: 'pr_open', branch: 'squadron/tdone', base: 'main', model: 'opus',
    prUrl: 'https://github.com/acme/financy/pull/40',
    summary: 'Added a Flatpak manifest and a GitHub Actions job that builds and publishes to Flathub on tagged releases. Documented the release steps in CONTRIBUTING.md.',
    costUsd: 0.214, createdAt: now - 18 * 60000,
    events: [
      { kind: 'status', text: 'agent online · claude-sonnet-4-6' },
      { kind: 'tool', text: '📝 write build-aux/com.acme.Financy.yml' },
      { kind: 'tool', text: '✏️  edit .github/workflows/release.yml' },
      { kind: 'result', text: 'agent finished', ok: true, costUsd: 0.214 },
      { kind: 'status', text: 'Pushing branch to origin…' },
      { kind: 'result', text: 'Pull request opened → https://github.com/acme/financy/pull/40', ok: true },
    ],
  },
]

const DEMO_DIFF = `diff --git a/build-aux/com.acme.Financy.yml b/build-aux/com.acme.Financy.yml
new file mode 100644
--- /dev/null
+++ b/build-aux/com.acme.Financy.yml
@@ -0,0 +1,8 @@
+app-id: com.acme.Financy
+runtime: org.freedesktop.Platform
+runtime-version: '23.08'
+sdk: org.freedesktop.Sdk
+command: financy
+modules:
+  - name: financy
+    buildsystem: simple
diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -10,5 +10,9 @@ jobs:
       - uses: actions/checkout@v4
       - name: Build
         run: make build
+      - name: Publish to Flathub
+        run: flatpak-builder --install build build-aux/com.acme.Financy.yml
+        env:
+          FLATHUB_TOKEN: \${{ secrets.FLATHUB_TOKEN }}
`

export const reviewTask = {
  id: 'trev', owner: 'acme', repo: 'financy', kind: 'review', issueNumber: 40,
  issueTitle: 'Release to Flathub', status: 'reviewed', model: 'opus', costUsd: 0.08,
  createdAt: now - 60000,
  review: 'The Flathub packaging is solid; a couple of CI-hardening and freshness nits below.',
  findings: [
    { file: '.github/workflows/release.yml', line: 14, severity: 'quality', body: '`flatpak-builder` isn’t pinned and `--install` writes system-wide; prefer a pinned builder action and `--user` to keep CI hermetic.' },
    { file: '.github/workflows/release.yml', line: 16, severity: 'security', body: 'FLATHUB_TOKEN is exposed to a `run:` step — make sure this workflow can’t be triggered by forked PRs, or the token could leak.' },
    { file: 'build-aux/com.acme.Financy.yml', line: 3, severity: 'quality', body: 'runtime-version ‘23.08’ is aging — bump to the current freedesktop runtime for security updates.' },
  ],
  events: [],
}

const CHANGE_DIFF = `diff --git a/src/import.js b/src/import.js
new file mode 100644
--- /dev/null
+++ b/src/import.js
@@ -0,0 +1,9 @@
+import { parse } from './csv.js'
+
+export function importTransactions(text) {
+  const rows = parse(text)
+  return rows.map((r) => ({
+    date: r.Date,
+    amount: Number(r.Amount),
+    note: r.Description,
+  }))
+}
diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -12,6 +12,7 @@ const cli = {
   add: addTransaction,
   list: listTransactions,
   export: exportCsv,
+  import: importTransactions,
 }
`

// A staged local change set (agent committed in a worktree, not pushed).
export const changeTask = {
  id: 'tchg', owner: 'acme', repo: 'financy', kind: 'plan', issueNumber: 35,
  issueTitle: 'Add CSV import for transactions', status: 'changes_ready', model: 'opus', staged: true,
  branch: 'squadron/tchg', base: 'main', costUsd: 0.21, createdAt: now - 30000,
  summary: 'Added a CSV importer (src/import.js) that parses rows into transaction objects and wired an `import` command into the CLI. Mirrors the existing export path.',
  events: [
    { kind: 'text', text: 'Implemented the CSV importer and wired it into the CLI.' },
    { kind: 'tool', text: '📝 write src/import.js' },
    { kind: 'tool', text: '✏️  edit src/app.js' },
    { kind: 'result', text: 'execution finished', ok: true },
  ],
}

export function demoApi(path, opts) {
  if (path === '/api/me') return Promise.resolve({ login: 'acme' })
  if (path === '/api/usage') return Promise.resolve({
    ok: true,
    plan: 'default_claude_max_5x',
    buckets: {
      fiveHour: { utilization: 43, resetsAt: new Date(now + 130 * 60000).toISOString() },
      sevenDay: { utilization: 35, resetsAt: new Date(now + 3 * 86400000).toISOString() },
      sevenDayOpus: { utilization: 58, resetsAt: new Date(now + 3 * 86400000).toISOString() },
      sevenDaySonnet: { utilization: 1, resetsAt: new Date(now + 3 * 86400000).toISOString() },
    },
    fetchedAt: now,
  })
  if (path === '/api/status') return Promise.resolve({
    gh: { ok: true, user: 'acme' },
    claude: { ok: true, installed: true, plan: 'max 5x' },
  })
  if (/\/preview$/.test(path)) return Promise.resolve({ status: 'stopped', url: null, logs: [], command: 'npm run dev', source: 'detected' })
  if (/\/run-command$/.test(path)) return Promise.resolve({ command: null })
  if (/\/issues\//.test(path) && opts?.method === 'PATCH') {
    const b = opts.body ? JSON.parse(opts.body) : {}
    return Promise.resolve({ number: null, local: true, title: b.title, body: b.body, labels: [] })
  }
  if (/\/issues\/local/.test(path) && opts?.method === 'POST') return Promise.resolve({ id: 'Ldemo', local: true, title: 'Draft', body: '' })
  const detail = path.match(/\/issues\/(\d+)$/)
  if (detail) {
    for (const arr of Object.values(issuesByRepo)) {
      const f = arr.find((i) => String(i.number) === detail[1])
      if (f) return Promise.resolve({ ...f, body: f.body || 'This is demo issue text. In a real repo this is the issue body fetched from GitHub.' })
    }
    return Promise.resolve({ number: Number(detail[1]), title: '', body: '(demo)', labels: [] })
  }
  if (/\/tasks\/tchg\/diff$/.test(path)) return Promise.resolve({ diff: CHANGE_DIFF })
  if (/\/pulls\/\d+\/diff$/.test(path)) return Promise.resolve({ diff: DEMO_DIFF })
  if (opts?.method === 'POST' && /\/pulls\/\d+\/merge$/.test(path)) return Promise.resolve({ merged: '' })
  const prDetail = path.match(/\/pulls\/(\d+)$/)
  if (prDetail) {
    for (const arr of Object.values(pullsByRepo)) {
      const f = arr.find((p) => String(p.number) === prDetail[1])
      if (f) return Promise.resolve({ ...f, body: '(demo)', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    }
  }
  if (path === '/api/repos/all') return Promise.resolve(allRepos)
  if (path === '/api/repos') return Promise.resolve(repos)
  if (path === '/api/selected-repos') return Promise.resolve(repos.map((r) => r.nameWithOwner))
  if (/^\/api\/selected-repos/.test(path)) return Promise.resolve(repos.map((r) => r.nameWithOwner)) // POST/DELETE no-op
  if (path === '/api/tasks') return Promise.resolve([changeTask, reviewTask, ...tasks])
  const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)/)
  if (m) {
    const key = `${m[1]}/${m[2]}`
    return Promise.resolve(((m[3] === 'issues' ? issuesByRepo : pullsByRepo)[key]) || [])
  }
  return Promise.resolve({}) // dispatch / answer / cancel are no-ops in demo
}
