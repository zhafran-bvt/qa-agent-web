import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeneratedTestCase } from '../../src/shared/contracts';
import { buildGeneratedCaseBody, buildManageCaseBody } from '../../src/server/services/testrail';

test('buildGeneratedCaseBody maps a generated BDD case to add_case fields', () => {
  const testCase = {
    title: '[Web] Show AI summary',
    type: 'BDD',
    caseIntent: 'positive',
    jiraReference: 'ORB-3172',
    preconditions: 'User has a no-score result.',
    bddScenario: 'Feature: AI Summary\nScenario: View\nGiven x\nWhen y\nThen z',
  } as unknown as GeneratedTestCase;

  const body = buildGeneratedCaseBody(testCase);
  assert.equal(body.title, '[Web] Show AI summary');
  assert.equal(body.template_id, 4);
  assert.equal(body.type_id, 1); // BDD/positive -> functional
  assert.equal(body.refs, 'ORB-3172');
  assert.equal(body.custom_preconds, 'User has a no-score result.');
  assert.deepEqual(body.custom_testrail_bdd_scenario, [{ content: testCase.bddScenario }]);
});

test('buildManageCaseBody omits undefined fields and wraps the BDD scenario', () => {
  const body = buildManageCaseBody({ title: 'New case', refs: 'ORB-1', bddScenario: 'Feature: F\nScenario: S\nGiven a\nWhen b\nThen c' });
  assert.deepEqual(body, {
    title: 'New case',
    refs: 'ORB-1',
    custom_testrail_bdd_scenario: [{ content: 'Feature: F\nScenario: S\nGiven a\nWhen b\nThen c' }],
  });
  // untouched fields are absent (so update_case only changes what was provided)
  assert.equal('custom_preconds' in body, false);
  assert.equal('type_id' in body, false);
});

test('buildManageCaseBody clears the BDD scenario when given an empty string', () => {
  const body = buildManageCaseBody({ bddScenario: '' });
  assert.deepEqual(body.custom_testrail_bdd_scenario, []);
});

test('buildManageCaseBody passes through numeric ids and preconditions', () => {
  const body = buildManageCaseBody({ preconditions: 'pre', typeId: 2, priorityId: 3, templateId: 4 });
  assert.equal(body.custom_preconds, 'pre');
  assert.equal(body.type_id, 2);
  assert.equal(body.priority_id, 3);
  assert.equal(body.template_id, 4);
  assert.equal('title' in body, false);
});
