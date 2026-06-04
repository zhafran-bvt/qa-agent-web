import type { QaContext, ScopeSnapshotTranslation } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';
import { SourceExcerpt } from './SourceExcerpt';

interface ContextPanelProps {
  context: QaContext | null;
  analyzing: boolean;
  translation: ScopeSnapshotTranslation | null;
  translating: boolean;
  permissionApproved: boolean;
  overrideReason: string;
  busy: boolean;
  lang: UiLanguage;
  onLanguageChange: (value: UiLanguage) => void;
  onPermissionApprovedChange: (value: boolean) => void;
  onOverrideReasonChange: (value: string) => void;
}

function renderKeyValueRows(context: QaContext, translation: ScopeSnapshotTranslation | null, lang: UiLanguage) {
  const t = uiText[lang].context;
  return [
    [t.ticket, context.ticketKey],
    [t.epic, context.epic],
    [t.acSource, context.acceptanceCriteriaSource || 'none'],
    [t.confidence, context.confidenceLevel.toUpperCase()],
    [t.mainSummary, translation?.mainSummary || context.mainIssue.summary || '-'],
    [
      t.parentStory,
      context.scopeParentIssue
        ? `${context.scopeParentIssue.key}: ${translation?.parentStorySummary || context.scopeParentIssue.summary || ''}`
        : t.noParentStory,
    ],
    [
      t.scopedPrdSection,
      context.scopeConfluenceSection?.pageId
        ? `${context.scopeConfluenceSection.pageId}: ${translation?.scopedPrdSection || context.scopeConfluenceSection.matchedHeading || context.scopeConfluenceSection.title}`
        : t.noScopedPrd,
    ],
  ];
}

function contextSourceRows(context: QaContext, lang: UiLanguage) {
  const t = uiText[lang].context;
  return [
    ['Issue', '1'],
    ['Linked issues', String(context.linkedIssues.length)],
    ['Parent', context.scopeParentIssue ? '1' : t.none],
    ['Docs', String(context.confluencePages.length)],
    ['Comments', String(context.mainIssue.comments?.length || 0)],
    ['PRD', context.scopeConfluenceSection ? '1' : t.none],
  ];
}

export function ContextPanel({
  context,
  analyzing,
  translation,
  translating,
  permissionApproved,
  overrideReason,
  busy,
  lang,
  onLanguageChange,
  onPermissionApprovedChange,
  onOverrideReasonChange,
}: ContextPanelProps) {
  const t = uiText[lang].context;
  const displayConfidenceReasons = translation?.confidenceReasons?.length ? translation.confidenceReasons : context?.confidenceReasons || [];
  const displayAcceptanceCriteria = translation?.acceptanceCriteria?.length ? translation.acceptanceCriteria : context?.acceptanceCriteria || [];
  const displayUserStories = translation?.userStories?.length ? translation.userStories : context?.userStories || [];
  const diagnostics = context?.acceptanceCriteriaDiagnostics;
  const scopeDiagnosticsRows = diagnostics
    ? [
        [t.scopeAuthority, context.scopeAuthority?.type || t.none],
        [t.scopeAuthorityTitle, context.scopeAuthority?.title || t.none],
        [t.thinTicketFallback, diagnostics.thinTicketFallbackUsed ? t.yes : t.no],
        [t.prdMatchQuality, diagnostics.prdSubsectionMatchQuality || t.none],
        [t.matchedPrdHeading, diagnostics.matchedPrdSubsectionHeading || t.none],
        [t.discardedUserStoryFragments, String(diagnostics.userStoryFragmentsDiscardedCount || 0)],
      ]
    : [];
  return (
    <section className="panel scope-workspace">
      <div className="panel-header">
        <div>
          <h3>{t.title}</h3>
          <p>{t.subtitle}</p>
        </div>
        <div className="panel-actions">
          <button className={`button button-secondary button-small ${lang === 'en' ? 'active-filter' : ''}`} type="button" onClick={() => onLanguageChange('en')}>
            EN
          </button>
          <button className={`button button-secondary button-small ${lang === 'id' ? 'active-filter' : ''}`} type="button" onClick={() => onLanguageChange('id')}>
            {translating ? '...' : 'ID'}
          </button>
        </div>
      </div>

      {!context ? (
        analyzing ? (
          <div className="context-loading">
            <div className="summary">
              <strong>{t.loadingTitle}</strong>
              <div className="muted">{t.loadingBody}</div>
            </div>
            <div className="scope-metric-grid">
              {Array.from({ length: 6 }).map((_, index) => (
                <div className="scope-metric context-item-loading" key={index}>
                  <span className="skeleton-block skeleton-label" />
                  <div>
                    <span className="skeleton-block skeleton-line" />
                    <span className="skeleton-block skeleton-line skeleton-line-short" />
                  </div>
                </div>
              ))}
            </div>
            <div className="summary summary-status">
              <div className="skeleton-stack">
                <span className="skeleton-block skeleton-line" />
                <span className="skeleton-block skeleton-line" />
                <span className="skeleton-block skeleton-line skeleton-line-short" />
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-snapshot empty-next-steps">
            <strong>{t.emptyTitle}</strong>
            <p>{t.emptyBody}</p>
            <ol>
              {t.emptySteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )
      ) : (
        <>
          <div className="scope-metric-grid">
            {renderKeyValueRows(context, translation, lang).slice(0, 4).map(([label, value]) => (
              <div className="scope-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <div className={`trust-banner ${context.requiresConfidencePermission ? 'is-warning' : ''}`}>
            <div>
              <strong>{t.confidenceSummary}</strong>
              <span>{displayConfidenceReasons[0] || context.scopeAuthority?.reason || t.noConfidenceOverride}</span>
            </div>
            <span className={`status-badge ${context.requiresConfidencePermission ? 'warning' : 'success'}`}>
              {context.requiresConfidencePermission ? t.qaPermissionRequired : t.noConfidenceOverride}
            </span>
          </div>

          <div className="scope-body-grid">
            <div className="scope-source-card">
              <h4>Context</h4>
              <div className="source-row-list">
                {contextSourceRows(context, lang).map(([label, value]) => (
                  <div className="source-row-item" key={label}>
                    <span className="source-icon">{label.slice(0, 1)}</span>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="scope-source-card">
              <h3>{t.userStories}</h3>
              {displayUserStories.length ? (
                <ul className="story-list">
                  {displayUserStories.map((story) => (
                    <li key={story.id}>
                      <strong>{story.id}</strong> {story.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t.noUserStories}</p>
              )}
            </div>
          </div>

          <div className="acceptance-workspace">
            <h3>{t.acceptanceCriteria}</h3>
            {displayAcceptanceCriteria.length ? (
              <ul className="criteria-list">
                {displayAcceptanceCriteria.map((criterion) => (
                  <li className="criteria-item" key={criterion.id}>
                    <div className="criterion-head">
                      <span className="criteria-id">{criterion.id}</span>
                      <span className="status-badge success">Evidence</span>
                    </div>
                    <div className="criteria-text-block">
                      <div className="criteria-text">{criterion.text}</div>
                      <SourceExcerpt
                        criterionText={criterion.text}
                        excerpts={criterion.sourceExcerpts}
                        excerpt={criterion.sourceExcerpt}
                        location={criterion.sourceExcerptLocation}
                        url={criterion.sourceExcerptUrl}
                        kind={criterion.sourceExcerptKind}
                        confidence={criterion.sourceExcerptConfidence}
                        lang={lang}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.noAcceptanceCriteria}</p>
            )}
          </div>

          {scopeDiagnosticsRows.length ? (
            <details className="summary summary-detail scope-diagnostics-detail">
              <summary>{t.scopeDiagnostics}</summary>
              <div className="scope-diagnostics-grid">
                {scopeDiagnosticsRows.map(([label, value]) => (
                  <div className="scope-diagnostic-item" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          {context.requiresConfidencePermission ? (
            <div className="override-box">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={permissionApproved}
                  onChange={(event) => onPermissionApprovedChange(event.target.checked)}
                />
                <span>{t.overrideCheckbox}</span>
              </label>
              <label className="field compact">
                <span>{t.manualOverrideReason}</span>
                <textarea
                  value={overrideReason}
                  placeholder={t.manualOverridePlaceholder}
                  onChange={(event) => onOverrideReasonChange(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          {busy ? <div className="action-hint">{t.blockerGenerating}</div> : null}
        </>
      )}
    </section>
  );
}
