import fs from 'node:fs';
import path from 'node:path';

// Walk up from this file's location until we find package.json. Lets the
// package work in two layouts:
//   - source mode (tsx): foo.ts at repo root → start = repo root → match
//   - compiled mode (tsc → dist/): foo.js at dist/ → start = dist/ → walks up once → match
// Resources like selectors.json and skills/ live at the repo root in both.
function findRepoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo-root: could not find package.json walking up from ' + new URL(import.meta.url).pathname);
}

export const REPO_ROOT: string = findRepoRoot();
