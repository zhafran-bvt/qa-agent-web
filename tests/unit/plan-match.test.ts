import test from 'node:test';
import assert from 'node:assert/strict';
import { planNameMatchesStory } from '../../src/server/services/testrail-dashboard';

test('matches the story key as a whole token', () => {
  assert.equal(planNameMatchesStory('ORB-1248 — AI Assistance Summary', 'ORB-1248'), true);
  assert.equal(planNameMatchesStory('AI Assistance (ORB-1248)', 'ORB-1248'), true);
  assert.equal(planNameMatchesStory('ORB-1248', 'ORB-1248'), true);
  assert.equal(planNameMatchesStory('orb-1248 summary', 'ORB-1248'), true); // case-insensitive
});

test('does not match a key that is a prefix of a larger key', () => {
  assert.equal(planNameMatchesStory('ORB-12489 — other story', 'ORB-1248'), false);
  assert.equal(planNameMatchesStory('ORB-124 regression', 'ORB-1248'), false);
});

test('no match when key absent or empty', () => {
  assert.equal(planNameMatchesStory('Release regression plan', 'ORB-1248'), false);
  assert.equal(planNameMatchesStory('ORB-1248 plan', ''), false);
});
