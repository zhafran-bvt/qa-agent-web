import { Fragment, type ReactNode } from 'react';
import { uiText, type UiLanguage } from '../i18n';

interface SourceExcerptProps {
  criterionText: string;
  excerpt?: string;
  location?: string;
  url?: string;
  kind?: 'jira' | 'prd';
  confidence?: 'verbatim' | 'closest';
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

export function SourceExcerpt({ criterionText, excerpt, location, url, kind, confidence, lang }: SourceExcerptProps) {
  const t = uiText[lang].evidence;

  if (!excerpt) {
    return <div className="source-empty">{t.noSourceMatched}</div>;
  }

  const isVerbatim = confidence === 'verbatim';
  return (
    <details className="source-evidence">
      <summary className="source-summary">
        <span className="source-caret" aria-hidden="true">▸</span>
        <span className="source-word">{t.source}</span>
        {location ? (
          <span className="source-loc">
            ·{' '}
            {url ? (
              <a className="source-link" href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                {location} ↗
              </a>
            ) : (
              <span>{location}</span>
            )}
          </span>
        ) : null}
        <span className={`source-badge ${isVerbatim ? 'verbatim' : 'closest'}`}>
          {isVerbatim ? t.verbatim : t.closestMatch}
        </span>
      </summary>
      <blockquote className="source-quote" data-kind={kind || ''}>
        {highlightExcerpt(excerpt, criterionText)}
      </blockquote>
    </details>
  );
}
