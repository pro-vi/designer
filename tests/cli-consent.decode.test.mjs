import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConsent } from '../cli-flags.ts';

// `--yes` authorizes an irreversible delete, and cli.ts's generic flag parser
// hands it three different shapes. Each one is a named property here.

test('a bare --yes authorizes', () => {
  assert.deepEqual(decodeConsent(true), { consent: true, recoveredPositional: null });
});

test('--yes=false does NOT authorize, and is not mistaken for a filename', () => {
  for (const v of ['false', 'FALSE', ' no ', '0', 'off']) {
    assert.deepEqual(decodeConsent(v), { consent: false, recoveredPositional: null }, `"${v}" must refuse`);
  }
});

test('--yes=true authorizes without inventing a positional', () => {
  for (const v of ['true', 'YES', '1', 'on']) {
    assert.deepEqual(decodeConsent(v), { consent: true, recoveredPositional: null }, `"${v}" must authorize`);
  }
});

test('a filename swallowed by a bare --yes is recovered, not treated as a boolean', () => {
  assert.deepEqual(decodeConsent('landing-v2.html'), { consent: true, recoveredPositional: 'landing-v2.html' });
});

test('an absent --yes never authorizes', () => {
  assert.deepEqual(decodeConsent(undefined), { consent: false, recoveredPositional: null });
  assert.deepEqual(decodeConsent(false), { consent: false, recoveredPositional: null });
});

test('a file literally named "false" is refused rather than silently deleted', () => {
  // Deliberate trade: an explicit boolean literal always wins over a filename.
  // Refusing to act is the safe side of that ambiguity.
  assert.equal(decodeConsent('false').consent, false);
});

test('--yes= (empty value) expresses no consent and is not a filename', () => {
  assert.deepEqual(decodeConsent(''), { consent: false, recoveredPositional: null });
  assert.deepEqual(decodeConsent('   '), { consent: false, recoveredPositional: null });
});

test('a recovered filename is trimmed, not passed through with the parser spacing', () => {
  assert.deepEqual(decodeConsent(' landing.html '), { consent: true, recoveredPositional: 'landing.html' });
});
