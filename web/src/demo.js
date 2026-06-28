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

const L = (name, color) => ({ name, color })

export const issuesByRepo = {
  'acme/financy': [
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
    { number: 40, title: 'Release to Flathub', labels: [L('packaging', '0e8a16')], isDraft: false, reviewDecision: 'REVIEW_REQUIRED', additions: 213, deletions: 18, updatedAt: ago(20), url: '#' },
  ],
  'acme/timetracky': [],
}

export const tasks = [
  {
    id: 'twait', owner: 'acme', repo: 'financy', issueNumber: 3,
    issueTitle: 'Add password encryption for the local vault',
    status: 'waiting', branch: 'squadron/twait', base: 'main', prUrl: null,
    costUsd: null, createdAt: now - 4 * 60000,
    question: 'The vault is currently plaintext JSON. Should I derive the key from a user password (Argon2id) and prompt on unlock, or store the key in the OS keyring for passwordless unlock? They trade off security vs. convenience.',
    events: [
      { kind: 'status', text: 'agent online · claude-sonnet-4-6' },
      { kind: 'tool', text: '📖 read README.md' },
      { kind: 'tool', text: '📖 read src/vault/store.js' },
      { kind: 'tool', text: '🔍 grep "writeFileSync"' },
      { kind: 'text', text: 'The vault is persisted as plaintext JSON in store.js. Encryption touches the unlock flow, so the key-derivation choice is a product decision — I should confirm before committing to one.' },
      { kind: 'question', text: 'The vault is currently plaintext JSON. Should I derive the key from a user password (Argon2id) and prompt on unlock, or store the key in the OS keyring for passwordless unlock?' },
    ],
  },
  {
    id: 'trun', owner: 'acme', repo: 'timetracky', issueNumber: 14,
    issueTitle: 'Export tracked hours to CSV',
    status: 'running', branch: 'squadron/trun', base: 'main', prUrl: null,
    costUsd: null, createdAt: now - 2 * 60000,
    events: [
      { kind: 'status', text: 'agent online · claude-sonnet-4-6' },
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
    status: 'pr_open', branch: 'squadron/tdone', base: 'main',
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

export function demoApi(path) {
  if (path === '/api/repos') return Promise.resolve(repos)
  if (path === '/api/tasks') return Promise.resolve(tasks)
  const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)/)
  if (m) {
    const key = `${m[1]}/${m[2]}`
    return Promise.resolve(((m[3] === 'issues' ? issuesByRepo : pullsByRepo)[key]) || [])
  }
  return Promise.resolve({}) // dispatch / answer / cancel are no-ops in demo
}
