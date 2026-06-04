import { Fragment, type ReactNode } from 'react';
import { uiText, type UiLanguage } from '../i18n';
import type { SourceExcerptMatch } from '../../shared/contracts';

interface SourceExcerptProps {
  criterionText: string;
  excerpts?: SourceExcerptMatch[];
  excerpt?: string;
  location?: string;
  url?: string;
  kind?: 'jira' | 'prd';
  confidence?: 'verbatim' | 'closest' | 'weak';
  lang: UiLanguage;
}

const HIGHLIGHT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'when', 'their', 'will',
  'are', 'was', 'were', 'have', 'has', 'not', 'but', 'its', 'your', 'user', 'users', 'should',
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !HIGHLIGHT_STOPWORDS.has(token))
  );
}

// Wrap the words the excerpt shares with the criterion so the reviewer sees the
// connecting phrase at a glance. Purely presentational — the excerpt text is
// chosen server-side.
function highlightExcerpt(excerpt: string, criterionText: string): ReactNode {
  const tokens = significantTokens(criterionText);
  if (!tokens.size) return excerpt;
  return excerpt.split(/(\b[A-Za-z0-9-]+\b)/).map((part, index) => {
    const normalized = part.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (normalized && tokens.has(normalized)) {
      return <mark key={index}>{part}</mark>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function SourceExcerpt({ criterionText, excerpts, excerpt, location, url, kind, confidence, lang }: SourceExcerptProps) {
  const t = uiText[lang].evidence;
  const normalizedExcerpts = (excerpts && excerpts.length
    ? excerpts
    : excerpt
      ? [{ text: excerpt, location, url, kind, confidence }]
      : []).filter((item) => item?.text);

  if (!normalizedExcerpts.length) {
    return <div className="source-empty">{t.noSourceMatched}</div>;
  }

  const primary = normalizedExcerpts[0];
  const hasWeak = normalizedExcerpts.some((item) => item.confidence === 'weak');
  const allVerbatim = normalizedExcerpts.every((item) => item.confidence === 'verbatim');
  const badgeClass = hasWeak ? 'weak' : allVerbatim ? 'verbatim' : 'closest';
  const badgeText = hasWeak ? t.weakMatch : allVerbatim ? t.verbatim : t.closestMatch;
  return (
    <details className="source-evidence">
      <summary className="source-summary">
        <span className="source-caret" aria-hidden="true">▸</span>
        <span className="source-word">{t.source}</span>
        {primary.location ? (
          <span className="source-loc">
            ·{' '}
            {primary.url ? (
              <a className="source-link" href={primary.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                {primary.location} ↗
              </a>
            ) : (
              <span>{primary.location}</span>
            )}
          </span>
        ) : null}
        <span className={`source-badge ${badgeClass}`}>
          {badgeText}
        </span>
      </summary>
      <div className="source-quotes">
        {normalizedExcerpts.map((item, index) => (
          <blockquote key={`${item.text}-${index}`} className="source-quote" data-kind={item.kind || ''}>
            {highlightExcerpt(item.text, criterionText)}
          </blockquote>
        ))}
      </div>
    </details>
  );
}
