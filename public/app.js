let appState = {
  config: null,
  context: null,
  testCases: [],
  validation: [],
  coverage: null,
  coverageEnforced: false,
  manualScopeOverride: false,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Working...';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

async function loadConfig() {
  appState.config = await api('/api/config');
  $('auth-status').textContent = appState.config.authenticated ? `Logged in: ${appState.config.user}` : 'Not logged in';
  $('login-link').classList.toggle('hidden', appState.config.authenticated);
  $('logout-button').classList.toggle('hidden', !appState.config.authenticated);
  $('section-id').value = appState.config.defaults.testrailSectionId || '';
}

function summarizeContext(context) {
  const linked = context.linkedIssues
    .map((issue) => `${issue.key}: ${issue.summary || issue.fetchError || ''} [${issue.classification || 'other'}]`)
    .join('\n');
  const pages = context.confluencePages
    .map((page) => {
      const sources = (page.sourceRefs || [])
        .map((source) => [source.issueKey, source.relationship || source.sourceType, source.anchor || ''].filter(Boolean).join(' '))
        .join(', ');
      return `${page.id}: ${page.title || page.fetchError || ''}${sources ? ` (from ${sources})` : ''}`;
    })
    .join('\n');
  const stories = (context.userStories || []).map((story) => `${story.id}: ${story.text}`).join('\n');
  const acceptanceCriteria = (context.acceptanceCriteria || []).map((criterion) => `${criterion.id}: ${criterion.text}`).join('\n');
  const parentStory = context.scopeParentIssue
    ? `${context.scopeParentIssue.key}: ${context.scopeParentIssue.summary || ''} (${context.scopeParentRelation || ''})`
    : '-';
  const scopedSection = context.scopeConfluenceSection && context.scopeConfluenceSection.pageId
    ? `${context.scopeConfluenceSection.pageId}: ${context.scopeConfluenceSection.title || ''} -> ${context.scopeConfluenceSection.matchedHeading || context.scopeConfluenceSection.anchor || 'unmatched'}`
    : '-';

  return [
    `Ticket: ${context.ticketKey}`,
    `Epic: ${context.epic}`,
    `Main Summary: ${context.mainIssue.summary}`,
    `Scope Parent Story: ${parentStory}`,
    `Scoped PRD Section: ${scopedSection}`,
    `Acceptance Criteria Source: ${context.acceptanceCriteriaSource || 'none'}`,
    '',
    `User Stories (${(context.userStories || []).length}):`,
    stories || '-',
    '',
    `Acceptance Criteria (${(context.acceptanceCriteria || []).length}):`,
    acceptanceCriteria || '-',
    '',
    `Linked Issues (${context.linkedIssues.length}):`,
    linked || '-',
    '',
    `Confluence Pages (${context.confluencePages.length}):`,
    pages || '-',
  ].join('\n');
}

function summarizeConfidence(context) {
  if (!context) return 'No confidence assessment available.';
  return [
    `Confidence: ${String(context.confidenceLevel || 'unknown').toUpperCase()}`,
    ...(context.confidenceReasons || []),
    context.requiresConfidencePermission ? 'QA permission is required before generation.' : 'No QA permission gate is required.',
  ].join('\n');
}

function updateConfidenceUI() {
  const context = appState.context;
  const summary = $('confidence-summary');
  const approvalRow = $('confidence-approval-row');
  const reasonRow = $('override-reason-row');
  if (!context) {
    summary.textContent = 'No confidence assessment available.';
    summary.className = 'summary empty';
    approvalRow.classList.add('hidden');
    reasonRow.classList.add('hidden');
    $('generate-button').disabled = true;
    return;
  }

  summary.textContent = summarizeConfidence(context);
  summary.className = context.requiresConfidencePermission ? 'summary warn' : 'summary';
  approvalRow.classList.toggle('hidden', !context.requiresConfidencePermission);
  reasonRow.classList.toggle('hidden', !context.requiresConfidencePermission);
  updateGenerateButton();
}

function updateGenerateButton() {
  const context = appState.context;
  if (!context) {
    $('generate-button').disabled = true;
    return;
  }
  const permissionSatisfied = !context.requiresConfidencePermission || $('confidence-approved').checked;
  $('generate-button').disabled = !permissionSatisfied;
}

async function analyze() {
  const button = $('analyze-button');
  setBusy(button, true, 'Analyzing...');
  try {
    const response = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        jiraKey: $('jira-key').value,
        feOnly: $('fe-only').checked,
        beAlreadyTested: $('be-tested').checked,
        includeComments: $('include-comments').checked,
        notes: $('scope-notes').value,
      }),
    });
    appState.context = response.context;
    appState.testCases = [];
    appState.validation = [];
    appState.coverage = null;
    appState.coverageEnforced = false;
    appState.manualScopeOverride = false;
    $('confidence-approved').checked = false;
    $('override-reason').value = '';
    $('context-summary').classList.remove('empty');
    $('context-summary').textContent = summarizeContext(response.context);
    $('cases').innerHTML = '';
    $('validation-summary').textContent = 'No test cases generated.';
    $('validation-summary').className = 'summary empty';
    $('coverage-summary').textContent = summarizeCoverage(null, response.context, false, false);
    $('coverage-summary').className = 'summary';
    updateConfidenceUI();
  } catch (error) {
    $('context-summary').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

async function generate() {
  const button = $('generate-button');
  setBusy(button, true, 'Generating...');
  try {
    const response = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        context: appState.context,
        confidencePermissionApproved: $('confidence-approved').checked,
        manualScopeOverrideReason: $('override-reason').value,
      }),
    });
    appState.testCases = response.testCases;
    appState.validation = response.validation;
    appState.coverage = response.coverage;
    appState.coverageEnforced = response.coverageEnforced !== false;
    appState.manualScopeOverride = Boolean(response.manualScopeOverride);
    renderCases();
  } catch (error) {
    $('validation-summary').className = 'summary warn';
    $('validation-summary').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

function renderCases() {
  const container = $('cases');
  container.innerHTML = '';
  appState.testCases.forEach((testCase, index) => {
    const validation = appState.validation[index] || { valid: false, errors: ['Not validated.'] };
    const card = document.createElement('div');
    card.className = 'case-card';
    card.innerHTML = `
      <div class="case-grid">
        <label>Title<input data-field="title" data-index="${index}" value="${escapeAttr(testCase.title || '')}" /></label>
        <label>Type<input data-field="type" data-index="${index}" value="${escapeAttr(testCase.type || '')}" /></label>
        <label>Jira Reference<input data-field="jiraReference" data-index="${index}" value="${escapeAttr(testCase.jiraReference || testCase.refs || '')}" /></label>
      </div>
      <div class="case-grid meta-grid">
        <label>Covers AC<input data-field="coversAcceptanceCriteria" data-index="${index}" value="${escapeAttr(formatList(testCase.coversAcceptanceCriteria))}" /></label>
        <label>Source Scope<input data-field="sourceScope" data-index="${index}" value="${escapeAttr(formatList(testCase.sourceScope))}" /></label>
      </div>
      <label>Preconditions<textarea data-field="preconditions" data-index="${index}">${escapeHtml(testCase.preconditions || '')}</textarea></label>
      <label>BDD Scenario<textarea data-field="bddScenario" data-index="${index}">${escapeHtml(testCase.bddScenario || '')}</textarea></label>
      <div class="${validation.valid ? 'valid' : 'errors'}">${validation.valid ? 'Valid' : validation.errors.join('\n')}</div>
    `;
    container.appendChild(card);
  });
  container.querySelectorAll('input, textarea').forEach((input) => {
    input.addEventListener('input', updateCaseFromInput);
  });
  updateValidationSummary();
}

function updateCaseFromInput(event) {
  const index = Number(event.target.dataset.index);
  const field = event.target.dataset.field;
  appState.testCases[index][field] = field === 'coversAcceptanceCriteria' || field === 'sourceScope' ? parseList(event.target.value) : event.target.value;
  debounceValidate();
}

let validateTimer = null;
function debounceValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateCurrentCases, 300);
}

async function validateCurrentCases() {
  if (!appState.context) return;
  const response = await api('/api/validate', {
    method: 'POST',
    body: JSON.stringify({
      testCases: appState.testCases,
      jiraKey: appState.context.ticketKey,
      epic: appState.context.epic,
      feOnly: appState.context.constraints.feOnly,
      acceptanceCriteria: appState.context.acceptanceCriteria,
      enforceAcceptanceCriteria: appState.coverageEnforced,
    }),
  });
  appState.validation = response.validation;
  appState.coverage = response.coverage;
  renderCases();
}

function updateValidationSummary() {
  const invalid = appState.validation.filter((item) => !item.valid);
  $('validation-summary').className = invalid.length ? 'summary warn' : 'summary';
  $('validation-summary').textContent = invalid.length ? `${invalid.length} case(s) need fixes before approval.` : `${appState.testCases.length} case(s) valid.`;
  $('coverage-summary').className = 'summary';
  $('coverage-summary').textContent = summarizeCoverage(appState.coverage, appState.context, appState.coverageEnforced, appState.manualScopeOverride);
  updatePushButton();
}

function updatePushButton() {
  const valid = appState.testCases.length > 0 && appState.validation.every((item) => item.valid);
  const fullyCovered =
    !appState.coverageEnforced ||
    !appState.coverage ||
    !appState.coverage.uncoveredCriteria ||
    appState.coverage.uncoveredCriteria.length === 0;
  $('push-button').disabled = !(valid && fullyCovered && $('approved').checked && $('section-id').value.trim());
}

async function pushToTestrail() {
  const button = $('push-button');
  setBusy(button, true, 'Pushing...');
  try {
    const response = await api('/api/push', {
      method: 'POST',
      body: JSON.stringify({
        approved: $('approved').checked,
        sectionId: $('section-id').value,
        jiraKey: appState.context.ticketKey,
        epic: appState.context.epic,
        feOnly: appState.context.constraints.feOnly,
        acceptanceCriteria: appState.context.acceptanceCriteria,
        enforceAcceptanceCriteria: appState.coverageEnforced,
        testCases: appState.testCases,
      }),
    });
    $('push-results').textContent = JSON.stringify(response, null, 2);
  } catch (error) {
    $('push-results').textContent = error.message;
  } finally {
    setBusy(button, false);
    updatePushButton();
  }
}

function formatList(value) {
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeCoverage(coverage, context, enforced, manualScopeOverride) {
  const criteria = (context && context.acceptanceCriteria) || [];
  if (!criteria.length) {
    return 'No scoped acceptance criteria were extracted for this run.';
  }
  if (!coverage) {
    return [
      enforced ? 'AC coverage is enforced for this run.' : 'AC coverage is not enforced for this run.',
      ...(manualScopeOverride ? ['Manual scope override is active.'] : []),
      `Acceptance Criteria (${criteria.length}):`,
      ...criteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
    ].join('\n');
  }

  return [
    enforced ? `Acceptance Criteria Coverage: ${coverage.coveredCriteria}/${coverage.totalCriteria} covered` : 'Acceptance Criteria Coverage: not enforced for this run',
    ...(manualScopeOverride ? ['Manual scope override is active.'] : []),
    ...coverage.byCriterion.map((criterion) =>
      `${criterion.id}: ${criterion.text} -> ${criterion.coveredBy.length ? `covered by ${criterion.coveredBy.join(', ')}` : enforced ? 'NOT COVERED' : 'not enforced'}`
    ),
    ...(coverage.unmappedCases && coverage.unmappedCases.length && enforced ? [`Unmapped Cases: ${coverage.unmappedCases.join(', ')}`] : []),
  ].join('\n');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

$('analyze-button').addEventListener('click', analyze);
$('generate-button').addEventListener('click', generate);
$('confidence-approved').addEventListener('change', updateGenerateButton);
$('approved').addEventListener('change', updatePushButton);
$('section-id').addEventListener('input', updatePushButton);
$('push-button').addEventListener('click', pushToTestrail);
$('logout-button').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
});

loadConfig().catch((error) => {
  $('auth-status').textContent = error.message;
});
