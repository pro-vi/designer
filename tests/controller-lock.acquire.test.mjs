import test from 'node:test';
import assert from 'node:assert/strict';
import { tryAcquireDriverLock, releaseDriverLock } from '../designer-controller.ts';

// The lock that serializes tab-driving verbs. Its whole value is that check and
// set happen in ONE tick — a version that awaited between them would let two
// callers both see it free.

test('a second acquire on the same tab is refused and names the holder', () => {
  const locks = new Map();
  assert.equal(tryAcquireDriverLock(locks, 'sess::proj-a', 'iterate[a]'), null, 'first acquire succeeds');
  assert.equal(tryAcquireDriverLock(locks, 'sess::proj-a', 'deleteFile[b]'), 'iterate[a]', 'second is refused');
});

test('different tabs do not block each other (parallel --key work keeps working)', () => {
  const locks = new Map();
  assert.equal(tryAcquireDriverLock(locks, 'sess::proj-a', 'iterate[a]'), null);
  assert.equal(tryAcquireDriverLock(locks, 'sess::proj-b', 'iterate[b]'), null, 'a different project is a different tab');
});

test('a refused caller does not clear or overwrite the holder', () => {
  const locks = new Map();
  tryAcquireDriverLock(locks, 'sess::proj-a', 'iterate[a]');
  tryAcquireDriverLock(locks, 'sess::proj-a', 'deleteFile[b]');
  assert.equal(locks.get('sess::proj-a'), 'iterate[a]', 'holder is unchanged after a refusal');
});

test('release frees the tab for the next caller', () => {
  const locks = new Map();
  tryAcquireDriverLock(locks, 'sess::proj-a', 'iterate[a]');
  releaseDriverLock(locks, 'sess::proj-a');
  assert.equal(tryAcquireDriverLock(locks, 'sess::proj-a', 'deleteFile[b]'), null);
});

test('releasing a tab nobody holds is harmless', () => {
  const locks = new Map();
  releaseDriverLock(locks, 'sess::never-held');
  assert.equal(locks.size, 0);
});

// --- the epoch that lock-free readers use to detect ABA ---
import { driverEpoch } from '../designer-controller.ts';

test('every acquired lock advances that driver\'s epoch', () => {
  const locks = new Map();
  const before = driverEpoch('sess');
  tryAcquireDriverLock(locks, 'sess', 'iterate[a]');
  assert.equal(driverEpoch('sess'), before + 1, 'an acquire is observable to lock-free readers');
});

test('a REFUSED acquire does not advance the epoch — nothing drove the tab', () => {
  const locks = new Map();
  tryAcquireDriverLock(locks, 'sess-refuse', 'iterate[a]');
  const after = driverEpoch('sess-refuse');
  tryAcquireDriverLock(locks, 'sess-refuse', 'deleteFile[b]'); // refused
  assert.equal(driverEpoch('sess-refuse'), after, 'a refusal is not a navigation');
});

test('an A -> B -> A round trip is still detectable, which URL equality alone is not', () => {
  const locks = new Map();
  const before = driverEpoch('sess-aba');
  tryAcquireDriverLock(locks, 'sess-aba', 'openFile[b]');
  releaseDriverLock(locks, 'sess-aba');
  tryAcquireDriverLock(locks, 'sess-aba', 'openFile[a]');
  releaseDriverLock(locks, 'sess-aba');
  assert.ok(driverEpoch('sess-aba') > before, 'the round trip is visible even though the endpoints match');
});

test('a DIFFERENT driver\'s activity does not invalidate this one\'s read', () => {
  // Under DESIGNER_CDP='' every key has its own session and its own tab. A
  // process-global counter made key B's work discard key A's status read of a
  // tab B cannot touch — defeating the isolation that mode provides.
  const locks = new Map();
  const mine = driverEpoch('driver-A');
  tryAcquireDriverLock(locks, 'driver-B', 'iterate[b]');
  releaseDriverLock(locks, 'driver-B');
  assert.equal(driverEpoch('driver-A'), mine, "another driver's operation is not my race");
});
