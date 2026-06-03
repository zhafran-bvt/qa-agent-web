#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const hooksPath = path.join(repoRoot, '.githooks');

execFileSync('git', ['config', 'core.hooksPath', hooksPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});

console.log(`Configured git hooks path: ${hooksPath}`);
