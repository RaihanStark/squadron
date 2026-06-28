import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { conflictedFiles, mergeHasConflictMarkers, commitMerge } from './git.js'

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
