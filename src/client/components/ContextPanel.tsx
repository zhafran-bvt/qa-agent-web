import type { ReactElement } from 'react';
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
  generateBlocker: string;
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
    [t.scopeType, (context.constraints.scopeType || 'web').toUpperCase()],
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

type SourceIconName = 'issue' | 'linked' | 'parent' | 'docs' | 'comments' | 'prd';

interface ScopeSourceChip {
  key: SourceIconName;
  label: string;
  count: number;
  /** boolean sources (parent / PRD) show "No <label>" when absent instead of a 0 count */
  boolean?: boolean;
}

function scopeSourceChips(context: QaContext): ScopeSourceChip[] {
  return [
    { key: 'issue', label: 'Issue', count: 1 },
    { key: 'linked', label: 'Linked', count: context.linkedIssues.length },
    { key: 'parent', label: 'Parent', count: context.scopeParentIssue ? 1 : 0, boolean: true },
    { key: 'docs', label: 'Docs', count: context.confluencePages.length },
    { key: 'comments', label: 'Comments', count: context.mainIssue.comments?.length || 0 },
    { key: 'prd', label: 'PRD', count: context.scopeConfluenceSection ? 1 : 0, boolean: true },
  ];
}

const SOURCE_ICONS: Record<SourceIconName, ReactElement> = {
  issue: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  linked: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  parent: <path d="M12 19V5M5 12l7-7 7 7" />,
  docs: (
    <>
      <path d="M14 3v5h5" />
      <path d="M7 3h8l5 5v13H7z" />
    </>
  ),
  comments: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  prd: <path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />,
};

function SourceChipIcon({ name }: { name: SourceIconName }) {
  return (
    <span className="ic" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {SOURCE_ICONS[name]}
      </svg>
    </span>
  );
}

export function ContextPanel({
  context,
  analyzing,
  translation,
  translating,
  permissionApproved,
  overrideReason,
  busy,
  generateBlocker,
  lang,
  onLanguageChange,
  onPermissionApprovedChange,
  onOverrideReasonChange,
  onGenerate,
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
        ...(context?.constraints?.scopeType === 'api'
          ? ([
              [
                t.apiDocsReference,
                `${context?.constraints?.apiContractRelevant ? t.apiDocsUsed : t.apiDocsSkipped}${
                  context?.constraints?.apiContractRelevanceReason ? ` — ${context.constraints.apiContractRelevanceReason}` : ''
                }`,
              ],
            ] as Array<[string, string]>)
          : []),
        [t.apiDocs, context?.apiContract?.sourceUrl || t.none],
        [t.apiEndpointMatches, String(context?.apiContract?.matchedEndpoints.length || 0)],
        [t.apiWarnings, context?.apiContract?.warnings.join(' | ') || t.none],
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
          <div className="empty-centered">
            <span className="empty-ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <div className="empty-title">{t.emptyTitle}</div>
            <p className="empty-hint">{t.emptyBody}</p>
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

          <div className="scope-sources">
            <p className="section-label">{t.scopeSources}</p>
            <div className="src-strip">
              {scopeSourceChips(context).map((chip) => {
                const zero = chip.count === 0;
                return (
                  <span className={`src-chip ${zero ? 'zero' : ''}`} key={chip.key}>
                    <SourceChipIcon name={chip.key} />
                    {chip.boolean && zero ? null : <span className="n">{chip.count}</span>}
                    <span className="lbl">{chip.boolean && zero ? `No ${chip.label.toLowerCase()}` : chip.label}</span>
                  </span>
                );
              })}
            </div>
          </div>

          <div className="scope-stories">
            <p className="section-label">{t.userStories}</p>
            {displayUserStories.length ? (
              <ul className="story-list">
                {displayUserStories.map((story) => (
                  <li key={story.id}>
                    <strong>{story.id}</strong> {story.text}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="stories-empty">
                <span className="ic" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21a8 8 0 0 1 16 0" />
                  </svg>
                </span>
                {t.noUserStories}
              </div>
            )}
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

          <div className="scope-generate-footer">
            <button
              className="button button-generate"
              type="button"
              disabled={busy || Boolean(generateBlocker)}
              onClick={onGenerate}
            >
              {busy ? t.generating : t.generate}
            </button>
            {generateBlocker ? <span className="action-hint">{generateBlocker}</span> : null}
          </div>
        </>
      )}
    </section>
  );
}
