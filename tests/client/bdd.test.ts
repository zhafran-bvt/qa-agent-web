import { describe, expect, it } from 'vitest';
import { parseBddScenario, serializeBddScenario } from '../../src/client/lib/bdd';

describe('bdd parse/serialize', () => {
  it('round-trips a standard scenario and folds And into the current section', () => {
    const input = 'Feature: Login\nScenario: Valid login\nGiven a user\nWhen they submit\nAnd press enter\nThen they are in';
    const { parts, structured } = parseBddScenario(input);
    expect(structured).toBe(true);
    expect(parts.feature).toBe('Login');
    expect(parts.scenario).toBe('Valid login');
    expect(parts.given).toEqual(['a user']);
    expect(parts.when).toEqual(['they submit', 'press enter']);
    expect(parts.then).toEqual(['they are in']);
    // serialize -> parse is stable (no drift on edit)
    expect(parseBddScenario(serializeBddScenario(parts)).parts).toEqual(parts);
  });

  it('serialized output satisfies the validator substring checks', () => {
    const out = serializeBddScenario({ feature: 'F', scenario: 'S', given: ['g'], when: ['w'], then: ['t'] });
    for (const keyword of ['Feature:', 'Scenario:', 'Given ', 'When ', 'Then ']) {
      expect(out.includes(keyword)).toBe(true);
    }
  });

  it('keeps the keyword substring even when a step is empty', () => {
    const out = serializeBddScenario({ feature: '', scenario: '', given: [''], when: [''], then: [''] });
    expect(out.includes('Given ')).toBe(true);
    expect(out.includes('When ')).toBe(true);
    expect(out.includes('Then ')).toBe(true);
  });

  it('flags free-form prose as unstructured so the editor falls back to raw text', () => {
    expect(parseBddScenario('just some prose with no gherkin keywords').structured).toBe(false);
  });
});
