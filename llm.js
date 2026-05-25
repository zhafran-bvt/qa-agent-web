const https = require('https');

function requestJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsedBody;
          try {
            parsedBody = data ? JSON.parse(data) : {};
          } catch (error) {
            reject(new Error(`Invalid JSON from LLM provider: ${data.slice(0, 500)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsedBody);
            return;
          }
          const message = parsedBody.error && parsedBody.error.message ? parsedBody.error.message : `HTTP ${res.statusCode}`;
          const error = new Error(message);
          error.statusCode = res.statusCode;
          error.response = parsedBody;
          reject(error);
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('LLM provider returned an empty response.');

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);
    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }
    throw error;
  }
}

function findCaseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const directKeys = ['testCases', 'cases', 'test_cases', 'testcases'];
  for (const key of directKeys) {
    if (Array.isArray(value[key])) return value[key];
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child) && child.some((item) => item && typeof item === 'object' && (item.bddScenario || item.bdd_scenario))) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const nested = findCaseArray(child);
    if (nested) return nested;
  }

  return null;
}

function normalizeTextList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join('\n');
  }
  return String(value || '').trim();
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBddScenario(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return normalizeTextList(value);
  if (typeof value !== 'object') return String(value).trim();

  const lines = [];
  const feature = String(value.Feature || value.feature || '').trim();
  const scenario = String(value.Scenario || value.scenario || '').trim();
  if (feature) lines.push(`Feature: ${feature}`);
  if (scenario) lines.push(`Scenario: ${scenario}`);

  for (const stepName of ['Given', 'When', 'Then', 'And']) {
    const raw = value[stepName] || value[stepName.toLowerCase()];
    if (!raw) continue;
    const steps = Array.isArray(raw) ? raw : [raw];
    for (const step of steps) {
      const text = String(step || '').trim();
      if (!text) continue;
      lines.push(`${stepName} ${text.replace(/^(Given|When|Then|And)\s+/i, '')}`);
    }
  }

  if (lines.length) return lines.join('\n');
  return JSON.stringify(value, null, 2);
}

function normalizeCase(testCase, index) {
  return {
    id: testCase.id || testCase.testCaseId || testCase.test_case_id || `TC-${String(index + 1).padStart(2, '0')}`,
    title: testCase.title || '',
    type: testCase.type || '',
    jiraReference: testCase.jiraReference || testCase.jira_reference || testCase.refs || '',
    preconditions: normalizeTextList(testCase.preconditions || testCase.custom_preconds || ''),
    bddScenario: normalizeBddScenario(testCase.bddScenario || testCase.bdd_scenario || testCase.custom_testrail_bdd_scenario || ''),
    coversAcceptanceCriteria: normalizeIdList(testCase.coversAcceptanceCriteria || testCase.covers_acceptance_criteria || ''),
    sourceScope: normalizeIdList(testCase.sourceScope || testCase.source_scope || ''),
  };
}

function isFallbackError(error) {
  const message = String(error && error.message ? error.message : '').toLowerCase();
  return (
    error.statusCode === 429 ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('insufficient_quota') ||
    message.includes('billing') ||
    message.includes('token') ||
    message.includes('context length')
  );
}

async function generateWithProvider(provider, context) {
  const enforceCoverage = Boolean(context && context.coverageEnforced);
  const systemPrompt = [
    'You are a senior QA engineer.',
    'Generate BDD test cases only from the supplied Jira and Confluence context.',
    'Scope cases to what dev actually built, not the entire PRD.',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    'Each testCases item must include id, title, type, jiraReference, preconditions, bddScenario, coversAcceptanceCriteria, sourceScope.',
    'Titles must follow [Web][{Epic}][{Ticket ID}] Title.',
    'bddScenario must include Feature, Scenario, Given, When, Then, and useful And steps.',
    enforceCoverage
      ? 'Use only acceptance criterion ids that exist in context.acceptanceCriteria, such as AC-1.'
      : 'If context.coverageEnforced is false, coversAcceptanceCriteria may be an empty array.',
    enforceCoverage
      ? 'Every acceptance criterion in context.acceptanceCriteria must be covered by at least one test case across the generated set.'
      : 'When coverage is not enforced, focus on scoped FE behavior and keep coversAcceptanceCriteria empty unless the mapping is obvious.',
    enforceCoverage
      ? 'Every test case must list at least one coversAcceptanceCriteria id.'
      : 'Every test case must still include sourceScope referencing the Jira issues or scoped Story source used.',
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      instruction: 'Generate happy path, negative, and edge-case BDD test cases.',
      context,
    },
    null,
    2
  );

  const response = await requestJson(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }
  );

  const content = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  const parsed = extractJson(content);
  const cases = findCaseArray(parsed);
  if (!Array.isArray(cases)) {
    throw new Error('LLM response JSON must contain a testCases array.');
  }
  return {
    provider: provider.name,
    model: provider.model,
    testCases: cases.map(normalizeCase),
  };
}

async function generateTestCases(config, context) {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) {
    throw new Error('No LLM provider API key is configured.');
  }

  let lastError;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      return await generateWithProvider(provider, context);
    } catch (error) {
      lastError = error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error('LLM generation failed.');
}

module.exports = {
  generateTestCases,
  findCaseArray,
  normalizeBddScenario,
  normalizeCase,
  normalizeIdList,
  normalizeTextList,
  isFallbackError,
};
