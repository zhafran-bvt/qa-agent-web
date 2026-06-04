import type { DuplicateCaseRecommendation, ExistingTestRailCase, GeneratedTestCase } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface DuplicatePushReviewModalProps {
  lang: UiLanguage;
  jiraKey: string;
  sectionId: string;
  existingCases: ExistingTestRailCase[];
  generatedCases: GeneratedTestCase[];
  recommendations: DuplicateCaseRecommendation[];
  selectedCaseIds: string[];
  busy: boolean;
  onSelectedCaseIdsChange: (selectedCaseIds: string[]) => void;
  onCancel: () => void;
  onPushSelected: () => void;
}

function recommendationForCase(recommendations: DuplicateCaseRecommendation[], testCase: GeneratedTestCase): DuplicateCaseRecommendation {
  return (
    recommendations.find((item) => item.newCaseId === testCase.id) || {
      newCaseId: testCase.id,
      recommendation: 'review',
      overlap: 'partial_overlap',
      matchedExistingCaseIds: [],
      reason: 'Review manually before pushing this case.',
      deterministic: true,
    }
  );
}

export function DuplicatePushReviewModal({
  lang,
  jiraKey,
  sectionId,
  existingCases,
  generatedCases,
  recommendations,
  selectedCaseIds,
  busy,
  onSelectedCaseIdsChange,
  onCancel,
  onPushSelected,
}: DuplicatePushReviewModalProps) {
  const t = uiText[lang].duplicateReview;
  const selected = new Set(selectedCaseIds);
  const selectedCount = selectedCaseIds.length;

  function toggleCase(caseId: string) {
    const next = new Set(selected);
    if (next.has(caseId)) {
      next.delete(caseId);
    } else {
      next.add(caseId);
    }
    onSelectedCaseIdsChange(Array.from(next));
  }

  function selectRecommended() {
    onSelectedCaseIdsChange(
      generatedCases
        .filter((testCase) => recommendationForCase(recommendations, testCase).recommendation === 'include')
        .map((testCase) => testCase.id)
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="modal-card duplicate-review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-review-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">TestRail</div>
            <h2 id="duplicate-review-title">{t.title}</h2>
            <p>{t.subtitle(existingCases.length, jiraKey, sectionId)}</p>
          </div>
        </div>

        <div className="duplicate-review-grid">
          <section className="duplicate-review-section">
            <h3>{t.existingTitle}</h3>
            <div className="duplicate-existing-list">
              {existingCases.map((testCase) => (
                <article className="duplicate-existing-card" key={String(testCase.caseId)}>
                  <div className="duplicate-case-id">C{testCase.caseId}</div>
                  <div className="duplicate-case-title">{testCase.title}</div>
                  <div className="duplicate-case-meta">{testCase.refs}</div>
                  {testCase.webUrl ? (
                    <a href={testCase.webUrl} target="_blank" rel="noreferrer">
                      {t.openInTestrail}
                    </a>
                  ) : null}
                </article>
              ))}
            </div>
          </section>

          <section className="duplicate-review-section">
            <div className="duplicate-candidate-heading">
              <h3>{t.generatedTitle}</h3>
              <button className="button button-secondary button-small" type="button" onClick={selectRecommended}>
                {t.selectRecommended}
              </button>
            </div>
            <div className="duplicate-candidate-list">
              {generatedCases.map((testCase) => {
                const recommendation = recommendationForCase(recommendations, testCase);
                return (
                  <label className="duplicate-candidate-card" key={testCase.id}>
                    <input type="checkbox" checked={selected.has(testCase.id)} onChange={() => toggleCase(testCase.id)} />
                    <div>
                      <div className="duplicate-candidate-title">{testCase.title}</div>
                      <div className="duplicate-candidate-meta">
                        <span className={`duplicate-badge duplicate-badge-${recommendation.recommendation}`}>
                          {t.recommendation(recommendation.recommendation)}
                        </span>
                        <span>{t.overlap(recommendation.overlap)}</span>
                        {recommendation.matchedExistingCaseIds.length ? (
                          <span>{t.matches(recommendation.matchedExistingCaseIds.map((caseId) => `C${caseId}`).join(', '))}</span>
                        ) : null}
                      </div>
                      <p>{recommendation.reason}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        <div className="duplicate-review-actions">
          <div>{t.selectedCount(selectedCount, generatedCases.length)}</div>
          <div className="duplicate-review-buttons">
            <button className="button button-secondary" type="button" onClick={onCancel}>
              {t.cancel}
            </button>
            <button className="button button-danger" type="button" disabled={busy || selectedCount === 0} onClick={onPushSelected}>
              {busy ? t.pushing : t.pushSelected}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
