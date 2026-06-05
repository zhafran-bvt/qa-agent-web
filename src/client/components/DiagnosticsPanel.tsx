import type { DiagnosticsResponse } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface DiagnosticsPanelProps {
  diagnostics: DiagnosticsResponse | null;
  lang: UiLanguage;
  showHeader?: boolean;
}

export function DiagnosticsPanel({ diagnostics, lang, showHeader = true }: DiagnosticsPanelProps) {
  const t = uiText[lang].diagnostics;
  return (
    <section className="panel panel-stack panel-secondary">
      {showHeader ? (
        <div className="panel-heading">
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
      ) : null}

      {!diagnostics ? (
        <div className="diagnostics-empty">
          <strong>{t.unavailable}</strong>
          <span>{t.unavailableBody}</span>
        </div>
      ) : (
        <>
          <div className="diagnostics-row-grid">
            <div className="diagnostics-row">
              <span className="context-label">{t.persistence}</span>
              <div className="context-value">
                {diagnostics.persistence.mode} - {t.migration(diagnostics.persistence.currentVersion || 'none')}
              </div>
            </div>
            <div className="diagnostics-row">
              <span className="context-label">{t.selectedResource}</span>
              <div className="context-value">
                {diagnostics.auth.selectedResource
                  ? `${diagnostics.auth.selectedResource.name || diagnostics.auth.selectedResource.url || diagnostics.auth.selectedResource.cloudId}`
                  : t.noActiveSession}
              </div>
            </div>
            <div className="diagnostics-row">
              <span className="context-label">{t.privacy}</span>
              <div className="context-value">
                {t.privacySummary(
                  diagnostics.privacy.storedAccountCount,
                  diagnostics.privacy.dueAccountCount,
                  diagnostics.privacy.lastCyclePeriodDays || 7
                )}
              </div>
            </div>
          </div>

          <div className="diagnostics-readiness" aria-label={t.readinessTitle}>
            <span className={diagnostics.readiness.atlassian ? 'status-badge success' : 'status-badge warning'}>{t.atlassian(diagnostics.readiness.atlassian)}</span>
            <span className={diagnostics.readiness.llm ? 'status-badge success' : 'status-badge warning'}>{t.llm(diagnostics.readiness.llm)}</span>
            <span className={diagnostics.readiness.testrail ? 'status-badge success' : 'status-badge warning'}>{t.testrail(diagnostics.readiness.testrail)}</span>
            <span className={diagnostics.readiness.database ? 'status-badge success' : 'status-badge warning'}>{t.database(diagnostics.readiness.database)}</span>
          </div>

          <div className="summary">
            <strong>{t.recentIssues}</strong>
            {diagnostics.recentIssues.length ? (
              <ul>
                {diagnostics.recentIssues.map((issue) => (
                  <li key={`${issue.timestamp}-${issue.message}`}>
                    [{issue.level}] {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">{t.noRecentIssues}</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
