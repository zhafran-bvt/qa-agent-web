#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const stampPath = path.join(repoRoot, '.git', 'qa-review-stamp.json');

function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const stagedFiles = capture('git', ['diff', '--cached', '--name-only']);
if (!stagedFiles) process.exit(0);

if (!fs.existsSync(stampPath)) {
  console.error('Missing QA review stamp for staged changes.');
  console.error('Run `npm run review:qa` before committing.');
  process.exit(1);
}

const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
const stagedTree = capture('git', ['write-tree']);

if (stamp.stagedTree !== stagedTree) {
  console.error('Staged changes differ from the last QA-reviewed snapshot.');
  console.error('Re-run `npm run review:qa` before committing.');
  process.exit(1);
}

process.exit(0);
