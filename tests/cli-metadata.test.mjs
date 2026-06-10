import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function runDesigner(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['dist/cli.js', ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

test('top-level version flags print the package version', async () => {
  for (const args of [['--version'], ['-v'], ['version']]) {
    const result = await runDesigner(args);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), pkg.version);
    assert.equal(result.stderr.trim(), '');
  }
});

test('top-level help remains successful', async () => {
  const result = await runDesigner(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CLI \+ MCP/);
  assert.equal(result.stderr.trim(), '');
});
