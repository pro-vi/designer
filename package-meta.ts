import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './repo-root.ts';

interface PackageMetadata {
  name: string;
  version: string;
}

function readPackageMetadata(): PackageMetadata {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };

  return {
    name: typeof raw.name === 'string' ? raw.name : 'designer',
    version: typeof raw.version === 'string' ? raw.version : '0.0.0'
  };
}

export const PACKAGE_METADATA = readPackageMetadata();
export const PACKAGE_VERSION = PACKAGE_METADATA.version;
