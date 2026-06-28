import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ciState, failedRunIds } from './github.js'

test('ciState returns "none" for an empty or non-array rollup', () => {
  assert.equal(ciState([]), 'none')
  assert.equal(ciState(null), 'none')
  assert.equal(ciState(undefined), 'none')
})

test('ciState reports failure when any check fails (failure wins over pending)', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]
  assert.equal(ciState(rollup), 'failure')
})

test('ciState reports pending when a check is not complete and none failed', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'QUEUED' },
  ]
  assert.equal(ciState(rollup), 'pending')
})

test('ciState reports success when all checks pass', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { state: 'SUCCESS' },
  ]
  assert.equal(ciState(rollup), 'success')
})

test('ciState handles legacy StatusContext entries', () => {
  assert.equal(ciState([{ state: 'ERROR' }]), 'failure')
  assert.equal(ciState([{ state: 'PENDING' }]), 'pending')
})

test('failedRunIds extracts run ids only from failing CheckRun entries', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/1' },
    { status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/222/job/2' },
    { status: 'IN_PROGRESS', detailsUrl: 'https://github.com/o/r/actions/runs/333/job/3' },
  ]
  assert.deepEqual(failedRunIds(rollup), ['222'])
})

test('failedRunIds de-duplicates ids and reads legacy targetUrl', () => {
  const rollup = [
    { status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/222/job/2' },
    { status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/o/r/actions/runs/222/job/9' },
    { state: 'FAILURE', targetUrl: 'https://github.com/o/r/actions/runs/444' },
  ]
  assert.deepEqual(failedRunIds(rollup), ['222', '444'])
})

test('failedRunIds ignores failing entries without an Actions run link', () => {
  assert.deepEqual(failedRunIds([{ state: 'FAILURE', targetUrl: 'https://ci.example.com/build/9' }]), [])
  assert.deepEqual(failedRunIds(null), [])
})
