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

// Verb registration is THREE separate surfaces — the `switch` in run(), the
// TOP_HELP text, and the HELP record that `designer <verb> --help` reads. A verb
// wired into only one or two of them either vanishes from discovery or exits 1
// on --help, and nothing caught that before this test.
// Verbs that predate this check and have no dedicated HELP entry. `--help` on
// them falls back to TOP_HELP and still exits 0, so this is a docs gap, not a
// break — grandfathered so the check gates NEW verbs instead of demanding an
// unrelated docs sweep. Removing a name from this list is a welcome fix.
const HELP_ENTRY_GRANDFATHERED = new Set(['open', 'create', 'resume', 'adopt', 'clear', 'help']);
// `resume` is described inside the `session` block rather than on its own line.
const TOP_HELP_GRANDFATHERED = new Set(['resume']);

test('every CLI verb appears in both TOP_HELP and the HELP record', async () => {
  const src = await readFile(path.join(root, 'cli.ts'), 'utf8');
  const body = src.slice(src.indexOf('switch (cmd)'));
  const verbs = [...body.matchAll(/^\s{4}case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);
  assert.ok(verbs.length > 5, `expected to find the verb switch, got ${verbs.length} cases`);

  const topHelp = src.slice(src.indexOf('const TOP_HELP'), src.indexOf('const HELP'));
  const helpRecord = src.slice(src.indexOf('const HELP'));
  const missing = [];
  for (const v of new Set(verbs)) {
    const inTop = TOP_HELP_GRANDFATHERED.has(v) || new RegExp(`(^|\\s)${v}[\\s"'\`]`, 'm').test(topHelp);
    const inHelp =
      HELP_ENTRY_GRANDFATHERED.has(v) || new RegExp(`(^|\\s)(${v}|'${v}'|"${v}"):`, 'm').test(helpRecord);
    if (!inTop || !inHelp) missing.push(`${v}${inTop ? '' : ' [TOP_HELP]'}${inHelp ? '' : ' [HELP]'}`);
  }
  assert.deepEqual(missing, [], `verbs missing from a help surface: ${missing.join(', ')}`);
});

test('a destructive verb is dry-run by default (files-delete needs --yes)', async () => {
  const src = await readFile(path.join(root, 'cli.ts'), 'utf8');
  const start = src.indexOf("case 'files-delete':");
  assert.ok(start > 0, 'files-delete case must exist');
  const block = src.slice(start, start + 1400);
  assert.match(block, /if \(!consent\)/, 'must gate the destructive path behind decoded consent');
  assert.match(block, /dryRun: true/, 'the ungated path must be a dry run');
});

// This is a public package. A harness that creates and deletes real user
// projects has no business inside it, however well gated.
test('the destructive e2e harness is not published', async () => {
  const cfg = JSON.parse(await readFile(path.join(root, 'tsconfig.build.json'), 'utf8'));
  assert.ok(
    (cfg.exclude ?? []).some((p) => /e2e/.test(p)),
    'the build must exclude the e2e harness so it never reaches dist/ (and therefore npm)'
  );
});
