import { useState } from 'react';
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
  onGenerate: () => void;
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
  onGenerate,
}: ContextPanelProps) {
  const t = uiText[lang].context;
  const s = uiText[lang].stepper;
  const [collapsed, setCollapsed] = useState(false);
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
    <section className={`panel panel-stack panel-context${collapsed ? ' panel-collapsed' : ''}`}>
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">2</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
        <div className="panel-actions">
          <button className={`button button-secondary button-small ${lang === 'en' ? 'active-filter' : ''}`} type="button" onClick={() => onLanguageChange('en')}>
            EN
          </button>
          <button className={`button button-secondary button-small ${lang === 'id' ? 'active-filter' : ''}`} type="button" onClick={() => onLanguageChange('id')}>
            {translating ? '...' : 'ID'}
          </button>
        </div>
        <button type="button" className="panel-collapse-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? s.expand : s.collapse} ${t.title}`} onClick={() => setCollapsed((value) => !value)}>{collapsed ? '▸' : '▾'}</button>
      </div>

      {!context ? (
        analyzing ? (
          <div className="context-loading">
            <div className="summary">
              <strong>{t.loadingTitle}</strong>
              <div className="muted">{t.loadingBody}</div>
            </div>
            <div className="context-grid context-grid-compact">
              {Array.from({ length: 6 }).map((_, index) => (
                <div className="context-item context-item-loading" key={index}>
                  <span className="context-label skeleton-block skeleton-label" />
                  <div className="context-value">
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
          <div className="summary muted">{t.noContext}</div>
        )
      ) : (
        <>
          <div className="context-grid context-grid-compact">
            {renderKeyValueRows(context, translation, lang).map(([label, value]) => (
              <div className="context-item" key={label}>
                <span className="context-label">{label}</span>
                <div className="context-value">{value}</div>
              </div>
            ))}
          </div>

          <div className={`summary summary-status ${context.requiresConfidencePermission ? 'summary-warn' : ''}`}>
            <strong>{t.confidenceSummary}</strong>
            <ul>
              {displayConfidenceReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <div>{context.requiresConfidencePermission ? t.qaPermissionRequired : t.noConfidenceOverride}</div>
          </div>

          {scopeDiagnosticsRows.length ? (
            <details className="summary summary-detail">
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

          <div className="details-grid">
            <div className="detail-card detail-card-primary">
              <h3>{t.acceptanceCriteria}</h3>
              {displayAcceptanceCriteria.length ? (
                <ul className="criteria-list">
                  {displayAcceptanceCriteria.map((criterion) => (
                    <li className="criteria-item" key={criterion.id}>
                      <span className="criteria-id">{criterion.id}</span>
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

            <div className="detail-card">
              <h3>{t.userStories}</h3>
              {displayUserStories.length ? (
                <ul>
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

          <button className="button button-generate" type="button" disabled={busy || (context.requiresConfidencePermission && !permissionApproved)} onClick={onGenerate}>
            {busy ? t.generating : t.generate}
          </button>
        </>
      )}
    </section>
  );
}
