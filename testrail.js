const https = require('https');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addCase(config, sectionId, testCase) {
  return new Promise((resolve, reject) => {
    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const url = new URL(`/index.php?/api/v2/add_case/${sectionId}`, baseUrl);
    const auth = Buffer.from(`${config.user}:${config.apiKey}`).toString('base64');
    const payload = JSON.stringify({
      title: testCase.title,
      template_id: 4,
      type_id: testCase.type_id || mapType(testCase.type),
      priority_id: testCase.priority_id || 2,
      refs: testCase.jiraReference || testCase.refs,
      custom_preconds: testCase.preconditions || testCase.custom_preconds,
      custom_testrail_bdd_scenario: [{ content: testCase.bddScenario || testCase.custom_testrail_bdd_scenario }],
    });

    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch (error) {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${body}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function mapType(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('negative')) return 2;
  if (normalized.includes('edge')) return 5;
  return 1;
}

async function pushCases(config, sectionId, testCases) {
  const results = [];
  for (const testCase of testCases) {
    try {
      const result = await addCase(config, sectionId, testCase);
      results.push({ ok: true, title: testCase.title, caseId: result.id });
    } catch (error) {
      results.push({ ok: false, title: testCase.title, error: error.message });
    }
    await delay(250);
  }
  return results;
}

module.exports = {
  pushCases,
  mapType,
};
