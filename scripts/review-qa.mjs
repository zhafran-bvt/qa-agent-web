#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const stampPath = path.join(repoRoot, '.git', 'qa-review-stamp.json');
const reviewerGuide = path.join(repoRoot, 'docs', 'qa-reviewer-agent.md');

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function hasStagedChanges() {
  return capture('git', ['diff', '--cached', '--name-only']) !== '';
}

if (!hasStagedChanges()) {
  console.error('No staged changes found. Stage your changes first, then run `npm run review:qa`.');
  process.exit(1);
}

console.log(`QA reviewer guide: ${reviewerGuide}`);
console.log('Running required verification before commit...');

run('npm', ['test']);
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'build']);

const stagedTree = capture('git', ['write-tree']);
const head = capture('git', ['rev-parse', '--verify', 'HEAD']);
const stagedFiles = capture('git', ['diff', '--cached', '--name-only'])
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

fs.writeFileSync(
  stampPath,
  JSON.stringify(
    {
      stagedTree,
      head,
      stagedFiles,
      reviewerGuide,
      reviewedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);

console.log('QA review stamp recorded for current staged tree.');
console.log('Commit can proceed while staged content remains unchanged.');
