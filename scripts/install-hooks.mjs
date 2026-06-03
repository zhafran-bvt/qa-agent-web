#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const hooksPath = path.join(repoRoot, '.githooks');

function inGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

if (!inGitRepo()) {
  console.log('Skipping git hook installation: no git repository detected.');
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', hooksPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});

console.log(`Configured git hooks path: ${hooksPath}`);
