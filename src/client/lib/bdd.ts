// Parse/serialize a BDD scenario string into editable parts and back.
// The serialized form mirrors the server's `normalizeBddScenario` output and
// therefore satisfies the validator, which requires the substrings
// `Feature:`, `Scenario:`, `Given `, `When `, `Then `.

export interface BddParts {
  feature: string;
  scenario: string;
  given: string[];
  when: string[];
  then: string[];
}

export type BddStepSection = 'given' | 'when' | 'then';

export function emptyBddParts(): BddParts {
  return { feature: '', scenario: '', given: [], when: [], then: [] };
}

export function parseBddScenario(value: string): { parts: BddParts; structured: boolean } {
  const parts = emptyBddParts();
  const lines = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim());

  let current: BddStepSection | null = null;
  let sawStep = false;

  for (const line of lines) {
    if (!line) continue;

    const featureMatch = line.match(/^feature:\s*(.*)$/i);
    if (featureMatch) {
      parts.feature = featureMatch[1].trim();
      continue;
    }

    const scenarioMatch = line.match(/^scenario(?:\s+outline)?:\s*(.*)$/i);
    if (scenarioMatch) {
      parts.scenario = scenarioMatch[1].trim();
      continue;
    }

    const stepMatch = line.match(/^(given|when|then|and|but)\b\s*(.*)$/i);
    if (stepMatch) {
      const keyword = stepMatch[1].toLowerCase();
      const text = stepMatch[2].trim();
      if (keyword === 'given' || keyword === 'when' || keyword === 'then') {
        current = keyword;
      }
      if (current) {
        parts[current].push(text);
        sawStep = true;
      }
      continue;
    }

    // Non-keyword line: treat as a continuation of the current section.
    if (current) {
      parts[current].push(line);
      sawStep = true;
    }
  }

  return { parts, structured: sawStep };
}

export function serializeBddScenario(parts: BddParts): string {
  const lines: string[] = [];
  lines.push(`Feature:${parts.feature ? ` ${parts.feature}` : ''}`);
  lines.push(`Scenario:${parts.scenario ? ` ${parts.scenario}` : ''}`);

  const appendSection = (keyword: string, steps: string[]) => {
    steps.forEach((step, index) => {
      // Keep the trailing space so the validator's `Given `/`When `/`Then `
      // substring checks pass even for an empty step line.
      lines.push(`${index === 0 ? keyword : 'And'} ${step}`);
    });
  };

  appendSection('Given', parts.given);
  appendSection('When', parts.when);
  appendSection('Then', parts.then);

  return lines.join('\n');
}
