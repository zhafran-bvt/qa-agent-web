import type { DiagnosticsResponse } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface DiagnosticsPanelProps {
  diagnostics: DiagnosticsResponse | null;
  lang: UiLanguage;
}

export function DiagnosticsPanel({ diagnostics, lang }: DiagnosticsPanelProps) {
  const t = uiText[lang].diagnostics;
  return (
    <section className="panel panel-stack panel-secondary">
      <div className="panel-heading">
        <div>
          <h2>{t.title}</h2>
          <p>{t.subtitle}</p>
        </div>
      </div>

      {!diagnostics ? (
        <div className="summary muted">{t.unavailable}</div>
      ) : (
        <>
          <div className="context-grid">
            <div className="context-item">
              <span className="context-label">{t.persistence}</span>
              <div className="context-value">
                {diagnostics.persistence.mode} · {t.migration(diagnostics.persistence.currentVersion || 'none')}
              </div>
            </div>
            <div className="context-item">
              <span className="context-label">{t.selectedResource}</span>
              <div className="context-value">
                {diagnostics.auth.selectedResource
                  ? `${diagnostics.auth.selectedResource.name || diagnostics.auth.selectedResource.url || diagnostics.auth.selectedResource.cloudId}`
                  : t.noActiveSession}
              </div>
            </div>
            <div className="context-item">
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

          <div className="summary">
            <div>{t.atlassian(diagnostics.readiness.atlassian)}</div>
            <div>{t.llm(diagnostics.readiness.llm)}</div>
            <div>{t.testrail(diagnostics.readiness.testrail)}</div>
            <div>{t.database(diagnostics.readiness.database)}</div>
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
