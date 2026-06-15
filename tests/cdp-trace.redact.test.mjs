import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, scrubSecrets } from '../cdp-trace.ts';

test('scrubSecrets redacts the common token shapes in body values', () => {
  const jwt = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH1234ix';
  assert.match(scrubSecrets(jwt), /\[redacted-jwt\]/);
  assert.ok(!scrubSecrets(jwt).includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'));

  const skKey = 'x sk-ant-api03-ABCDEFGHIJKLMNOP1234 y';
  assert.ok(!scrubSecrets(skKey).includes('ABCDEFGHIJKLMNOP1234'));

  assert.equal(scrubSecrets('{"accessToken":"deadbeefcafe1234"}'), '{"accessToken":"[redacted]"}');
  assert.equal(scrubSecrets('{"password":"hunter2hunter2"}'), '{"password":"[redacted]"}');
  assert.equal(scrubSecrets('sessionKey=sk-sess-abc123def;'), 'sessionKey=[redacted];');
  assert.match(scrubSecrets('Authorization: Bearer abcDEF123456ghiJKL'), /Bearer \[redacted\]/);
});

test('scrubSecrets leaves benign body content intact', () => {
  const html = '<html><body><h1>Aurora</h1><p>floating glass panels</p></body></html>';
  assert.equal(scrubSecrets(html), html);
});

test('redact still masks sensitive header keys (header-name path unchanged)', () => {
  const out = redact({ headers: { cookie: 'sessionKey=abc', authorization: 'Bearer y', 'x-foo': 'ok' } });
  assert.equal(out.headers.cookie, '[redacted]');
  assert.equal(out.headers.authorization, '[redacted]');
  assert.equal(out.headers['x-foo'], 'ok');
});
