import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { conflictedFiles, mergeHasConflictMarkers, commitMerge, prPreviewId } from './git.js'
import { resolveCommandFor } from './preview.js'

const run = promisify(execFile)

// Build a throwaway repo with a genuine merge conflict in the working tree, so
// the conflict helpers run against real git output rather than a mock.
async function makeConflictRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'squadron-git-'))
  const git = (args) => run('git', args, { cwd: dir })
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@squadron.local'])
  await git(['config', 'user.name', 'Squadron Test'])

  await writeFile(path.join(dir, 'file.txt'), 'base\n')
  await git(['add', '-A'])
  await git(['commit', '-q', '-m', 'base'])

  // Diverge: head branch vs. main both edit the same line.
  await git(['checkout', '-q', '-b', 'head'])
  await writeFile(path.join(dir, 'file.txt'), 'head change\n')
  await git(['commit', '-q', '-am', 'head edit'])

  await git(['checkout', '-q', 'main'])
  await writeFile(path.join(dir, 'file.txt'), 'main change\n')
  await git(['commit', '-q', '-am', 'main edit'])

  // Merge main into head with conflicts left in the tree.
  await git(['checkout', '-q', 'head'])
  await git(['merge', '--no-commit', '--no-ff', 'main']).catch(() => {})
  return { dir, git }
}

test('conflictedFiles lists files left unmerged by a conflicting merge', async () => {
  const { dir } = await makeConflictRepo()
  try {
    assert.deepEqual(await conflictedFiles(dir), ['file.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prPreviewId is deterministic and namespaced per owner/repo/number', () => {
  assert.equal(prPreviewId('acme', 'widgets', 42), 'pr-acme__widgets-42')
  // Stable across calls (the worktree is reused, not re-created, on restart).
  assert.equal(prPreviewId('acme', 'widgets', 42), prPreviewId('acme', 'widgets', 42))
  // Distinct repos / PRs never collide.
  assert.notEqual(prPreviewId('acme', 'widgets', 42), prPreviewId('acme', 'widgets', 43))
  assert.notEqual(prPreviewId('acme', 'widgets', 42), prPreviewId('other', 'widgets', 42))
})

test('resolveCommandFor: .squadron.json wins over auto-detection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'squadron-cmd-'))
  try {
    // A detectable npm project AND an explicit .squadron.json — the file wins.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    await writeFile(path.join(dir, '.squadron.json'), JSON.stringify({ run: 'make serve' }))
    assert.deepEqual(await resolveCommandFor({ wt: dir, repoSlug: 'no/such-override-xyz' }),
      { command: 'make serve', source: '.squadron.json' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveCommandFor: falls back to auto-detection, else null', async () => {
  const npmDir = await mkdtemp(path.join(os.tmpdir(), 'squadron-cmd-'))
  const goDir = await mkdtemp(path.join(os.tmpdir(), 'squadron-cmd-'))
  const bareDir = await mkdtemp(path.join(os.tmpdir(), 'squadron-cmd-'))
  try {
    await writeFile(path.join(npmDir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    assert.deepEqual(await resolveCommandFor({ wt: npmDir, repoSlug: 'no/such-override-xyz' }),
      { command: 'npm run dev', source: 'detected' })

    await writeFile(path.join(goDir, 'go.mod'), 'module example.com/x\n')
    assert.deepEqual(await resolveCommandFor({ wt: goDir, repoSlug: 'no/such-override-xyz' }),
      { command: 'go run .', source: 'detected' })

    // Nothing recognizable → no command.
    assert.equal(await resolveCommandFor({ wt: bareDir, repoSlug: 'no/such-override-xyz' }), null)
  } finally {
    await rm(npmDir, { recursive: true, force: true })
    await rm(goDir, { recursive: true, force: true })
    await rm(bareDir, { recursive: true, force: true })
  }
})

test('mergeHasConflictMarkers is true while markers remain, false once resolved', async () => {
  const { dir, git } = await makeConflictRepo()
  try {
    assert.equal(await mergeHasConflictMarkers(dir), true)
    // Resolve by picking a clean line, then the guard should clear.
    await writeFile(path.join(dir, 'file.txt'), 'resolved\n')
    await git(['add', 'file.txt'])
    assert.equal(await mergeHasConflictMarkers(dir), false)
    // And the merge can be committed without an editor prompt.
    await commitMerge(dir)
    const { stdout } = await git(['log', '--oneline', '-1', '--format=%P'])
    assert.equal(stdout.trim().split(' ').length, 2) // merge commit has two parents
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
