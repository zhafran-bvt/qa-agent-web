import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { TrAttachmentSummary, TrEvidenceStatus, TrPlanReviewResponse, TrPlanReviewRun, TrPlanReviewTest, TrPlanSummary } from '../../../shared/contracts';
import { passWithEvidence, testrailAttachmentUrl, uploadResultEvidence } from '../../api';
import type { UiLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { STATUS_ORDER, statusTone } from './status';

const VIDEO_RE = /\.(mov|mp4|m4v|webm|ogv)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

// Evidence upload constraints — mirror of the server gate (index.ts EVIDENCE_*).
const EVIDENCE_MAX_MB = 25;
const EVIDENCE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/pdf,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.m4v,.webm,.pdf';
const EVIDENCE_EXT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
};
const EVIDENCE_ALLOWED_TYPES = new Set(Object.values(EVIDENCE_EXT_TYPE));

// A file's reported type can be empty (e.g. some .mov), so fall back to the extension. Returns the
// resolved MIME, or '' when the file isn't an accepted evidence type.
function resolveEvidenceType(file: File): string {
  if (file.type && EVIDENCE_ALLOWED_TYPES.has(file.type)) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EVIDENCE_EXT_TYPE[ext] || '';
}

type EvidenceTarget =
  | { kind: 'result'; id: string | number }
  | { kind: 'pass'; runId: string | number; caseId: string | number };

function EvidenceUpload({ target, onUploaded, t }: { target: EvidenceTarget; onUploaded: () => void; t: typeof uiText.en.dashboard }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [doneCount, setDoneCount] = useState(0);
  const isPass = target.kind === 'pass';

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // let the same files be re-selected after an error
    if (!files.length) return;
    setError('');
    setDoneCount(0);
    // Validate every file up front so we never half-upload a batch and then fail.
    const prepared: Array<{ file: File; contentType: string }> = [];
    for (const file of files) {
      const contentType = resolveEvidenceType(file);
      if (!contentType) {
        setError(`${file.name}: ${t.evidenceUploadBadType}`);
        return;
      }
      if (file.size > EVIDENCE_MAX_MB * 1024 * 1024) {
        setError(`${file.name}: ${t.evidenceUploadTooLarge(EVIDENCE_MAX_MB)}`);
        return;
      }
      prepared.push({ file, contentType });
    }
    // Pass-with-evidence mutates TestRail (marks the test Passed), so confirm before doing it.
    if (isPass && !window.confirm(t.evidencePassConfirm)) return;
    setUploading(true);
    let uploaded = 0;
    try {
      if (isPass) {
        // First file records the Passed result; the rest attach to that same result so a multi-file
        // upload produces ONE result with N attachments (not N results).
        const [first, ...rest] = prepared;
        const { resultId } = await passWithEvidence(target.runId, target.caseId, first.file, first.contentType);
        uploaded += 1;
        for (const item of rest) {
          await uploadResultEvidence(resultId, item.file, item.contentType);
          uploaded += 1;
        }
      } else {
        for (const item of prepared) {
          await uploadResultEvidence(target.id, item.file, item.contentType);
          uploaded += 1;
        }
      }
      // Confirm success explicitly, THEN refresh after a beat. Without the explicit ✓ the only signal was
      // the badge flip — easy to miss (TestRail indexing lag), which led reviewers to re-upload.
      setDoneCount(uploaded);
      window.setTimeout(onUploaded, 1200);
    } catch (err) {
      // Report partial progress so the reviewer knows how many of the batch landed before the failure.
      const base = (err as Error).message || t.evidenceUploadFailed;
      setError(uploaded > 0 ? `${base} (${uploaded}/${prepared.length} uploaded)` : base);
      if (uploaded > 0) window.setTimeout(onUploaded, 1200);
    } finally {
      setUploading(false);
    }
  }

  const doneLabel = (isPass ? t.evidencePassDone : t.evidenceUploadDone) + (doneCount > 1 ? ` (${doneCount})` : '');
  return (
    <div className="tr-evidence-upload">
      <label
        className={`button button-secondary button-small ${uploading ? 'is-disabled' : ''}`}
        title={isPass ? t.evidencePassHint : t.evidenceUploadMultiHint}
      >
        {uploading ? t.evidenceUploading : isPass ? t.evidencePass : t.evidenceUpload}
        <input type="file" accept={EVIDENCE_ACCEPT} multiple hidden disabled={uploading} onChange={handleFiles} />
      </label>
      {doneCount > 0 ? (
        <span className="tr-evidence-upload-done" role="status">
          {doneLabel}
        </span>
      ) : null}
      {error ? (
        <span className="tr-evidence-upload-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function AttachmentPanel({ attachments, t }: { attachments: TrAttachmentSummary[]; t: typeof uiText.en.dashboard }) {
  const [index, setIndex] = useState(0);
  const multi = attachments.length > 1;
  const current = attachments[Math.min(index, attachments.length - 1)];
  const src = testrailAttachmentUrl(current.id, current.name);
  const isVideo = VIDEO_RE.test(current.name);
  const isImage = IMAGE_RE.test(current.name);
  const size = formatBytes(current.size);

  return (
    <div className="tr-evidence-panel">
      <div className="tr-att-head">
        <span className="tr-att-name" title={current.name}>
          {current.name}
        </span>
        {size ? <span className="tr-att-size">{size}</span> : null}
      </div>
      <div className="tr-att-stage">
        {multi ? (
          <button
            className="tr-att-nav tr-att-prev"
            type="button"
            aria-label={t.evidencePrev}
            onClick={() => setIndex((i) => (i - 1 + attachments.length) % attachments.length)}
          >
            ‹
          </button>
        ) : null}
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video className="tr-att-media" src={src} controls preload="metadata" />
        ) : isImage ? (
          <img className="tr-att-media" src={src} alt={current.name} />
        ) : (
          <div className="tr-att-unsupported">{t.evidenceUnsupported}</div>
        )}
        {multi ? (
          <button
            className="tr-att-nav tr-att-next"
            type="button"
            aria-label={t.evidenceNext}
            onClick={() => setIndex((i) => (i + 1) % attachments.length)}
          >
            ›
          </button>
        ) : null}
      </div>
      {multi ? (
        <div className="tr-att-foot">
          <div className="tr-att-dots" aria-hidden="true">
            {attachments.map((att, i) => (
              <span className={`tr-att-dot ${i === index ? 'is-active' : ''}`} key={`${att.id}-${i}`} />
            ))}
          </div>
          <span className="tr-att-count">{t.evidenceSlideCount(Math.min(index, attachments.length - 1) + 1, attachments.length)}</span>
        </div>
      ) : null}
      {multi ? (
        <div className="tr-att-thumbs">
          {attachments.map((att, i) => (
            <button
              className={`tr-att-thumb ${i === index ? 'is-active' : ''}`}
              type="button"
              key={`${att.id}-thumb-${i}`}
              title={att.name}
              onClick={() => setIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      ) : null}
      <div className="tr-att-actions">
        <a className="button button-secondary button-small" href={testrailAttachmentUrl(current.id, current.name, true)}>
          {t.evidenceDownload}
        </a>
      </div>
    </div>
  );
}

type EvidenceFilter = 'all' | 'missing' | 'passed';

interface PlanReviewModalProps {
  lang: UiLanguage;
  plan: TrPlanSummary;
  review: TrPlanReviewResponse | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
}

function StatusChips({ distribution }: { distribution: Record<string, number> }) {
  const chips = STATUS_ORDER.filter((key) => (distribution[key] || 0) > 0);
  if (!chips.length) return <span className="tr-muted">-</span>;
  return (
    <span className="tr-status-chips">
      {chips.map((key) => (
        <span className={`tr-chip tr-chip-${statusTone(key)}`} key={key} title={key}>
          {distribution[key]}
        </span>
      ))}
    </span>
  );
}

function evidenceClass(status: TrEvidenceStatus): string {
  if (status === 'present') return 'tr-evidence-ok';
  if (status === 'missing') return 'tr-evidence-warn';
  if (status === 'unknown') return 'tr-evidence-unknown';
  return 'tr-evidence-none';
}

function evidenceLabel(status: TrEvidenceStatus, attachmentCount: number, t: typeof uiText.en.dashboard): string {
  if (status === 'present') return t.reviewEvidencePresent(attachmentCount);
  if (status === 'missing') return t.reviewEvidenceMissing;
  if (status === 'unknown') return t.reviewEvidenceUnknown;
  return t.reviewEvidenceNotRequired;
}

function selectDefaultRun(runs: TrPlanReviewRun[]): number | null {
  if (!runs.length) return null;
  return (runs.find((run) => run.evidenceMissingCount > 0) || runs[0]).runId;
}

function matchesFilter(test: TrPlanReviewTest, filter: EvidenceFilter): boolean {
  if (filter === 'missing') return test.evidenceStatus === 'missing';
  if (filter === 'passed') return test.status === 'Passed';
  return true;
}

export function PlanReviewModal({ lang, plan, review, loading, error, onRetry, onClose }: PlanReviewModalProps) {
  const t = uiText[lang].dashboard;
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [filter, setFilter] = useState<EvidenceFilter>('all');
  const [openTestId, setOpenTestId] = useState<number | null>(null);

  useEffect(() => {
    setSelectedRunId(selectDefaultRun(review?.runs || []));
    setFilter('all');
    setOpenTestId(null);
  }, [review]);

  const selectedRun = useMemo(
    () => review?.runs.find((run) => run.runId === selectedRunId) || review?.runs[0] || null,
    [review, selectedRunId]
  );
  const visibleTests = useMemo(
    () => (selectedRun?.tests || []).filter((test) => matchesFilter(test, filter)),
    [filter, selectedRun]
  );

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card tr-review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tr-review-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="tr-review-head">
          <div>
            <div className="eyebrow">{t.reviewEyebrow}</div>
            <h2 id="tr-review-title">{plan.planName}</h2>
            <p>{t.reviewSubtitle}</p>
          </div>
          <div className="tr-review-actions">
            <a className="button button-secondary button-small" href={plan.webUrl} target="_blank" rel="noreferrer">
              {t.openInTestRail}
            </a>
            <button className="button button-secondary button-small" type="button" onClick={onClose}>
              {uiText[lang].status.close}
            </button>
          </div>
        </header>

        <div className="tr-review-body">
          {loading ? (
            <div className="tr-dashboard-state">{t.reviewLoading}</div>
          ) : error ? (
            <div className="tr-dashboard-state tr-dashboard-error">
              <p>{error}</p>
              <button className="button button-secondary button-small" type="button" onClick={onRetry}>
                {t.reviewRetry}
              </button>
            </div>
          ) : !review ? null : (
            <>
              <div className="tr-review-summary" aria-label={t.reviewSummaryLabel}>
                <div className="tr-review-metric">
                  <span>{t.reviewTotalRuns}</span>
                  <strong>{review.summary.totalRuns}</strong>
                </div>
                <div className="tr-review-metric">
                  <span>{t.reviewPassedTests}</span>
                  <strong>{review.summary.passedCount}</strong>
                </div>
                <div className="tr-review-metric">
                  <span>{t.reviewWithEvidence}</span>
                  <strong>{review.summary.evidencePresentCount}</strong>
                </div>
                <div className={`tr-review-metric ${review.summary.evidenceMissingCount ? 'is-alert' : ''}`}>
                  <span>{t.reviewMissingEvidence}</span>
                  <strong>{review.summary.evidenceMissingCount}</strong>
                </div>
              </div>

              <div className="tr-review-grid">
                <section className="tr-review-runs" aria-label={t.reviewRuns}>
                  <div className="tr-review-section-head">
                    <h3>{t.reviewRuns}</h3>
                    <span>{t.reviewRunCount(review.runs.length)}</span>
                  </div>
                  {review.runs.length ? (
                    review.runs.map((run) => (
                      <button
                        className={`tr-review-run ${run.runId === selectedRun?.runId ? 'is-active' : ''}`}
                        type="button"
                        key={run.runId}
                        onClick={() => setSelectedRunId(run.runId)}
                      >
                        <span className="tr-review-run-title">
                          <strong>{run.runName}</strong>
                          {run.evidenceMissingCount > 0 ? (
                            <span className="tr-evidence-pill tr-evidence-warn">{t.reviewMissingCount(run.evidenceMissingCount)}</span>
                          ) : run.passedCount > 0 ? (
                            <span className="tr-evidence-pill tr-evidence-ok">{t.reviewEvidenceComplete}</span>
                          ) : (
                            <span className="tr-evidence-pill tr-evidence-none">{t.reviewNoPassedTests}</span>
                          )}
                        </span>
                        <span className="tr-review-run-meta">
                          <span>{t.reviewTestsCount(run.totalTests)}</span>
                          <span>{t.reviewPassedCount(run.passedCount)}</span>
                        </span>
                        <StatusChips distribution={run.statusDistribution} />
                      </button>
                    ))
                  ) : (
                    <div className="tr-dashboard-state">{t.noRuns}</div>
                  )}
                </section>

                <section className="tr-review-tests" aria-label={t.reviewTests}>
                  <div className="tr-review-section-head">
                    <div className="tr-review-selected-head">
                      <h3>{selectedRun?.runName || t.reviewTests}</h3>
                      <div className="tr-review-selected-meta">
                        <span>{t.reviewEvidenceRule}</span>
                        {selectedRun ? <span>{t.reviewRunEvidenceSummary(selectedRun.evidenceMissingCount, selectedRun.passedCount)}</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="tr-review-filter" aria-label={t.reviewFilterLabel}>
                    <button className={filter === 'all' ? 'is-active' : ''} type="button" onClick={() => setFilter('all')}>
                      {t.filterAll}
                    </button>
                    <button className={filter === 'missing' ? 'is-active' : ''} type="button" onClick={() => setFilter('missing')}>
                      {t.reviewFilterMissing}
                    </button>
                    <button className={filter === 'passed' ? 'is-active' : ''} type="button" onClick={() => setFilter('passed')}>
                      {t.reviewFilterPassed}
                    </button>
                  </div>

                  <div className="tr-review-case-list">
                    {visibleTests.length ? (
                      visibleTests.map((test) => {
                        const hasAttachments = test.attachments.length > 0;
                        const isOpen = openTestId === test.testId;
                        return (
                          <article className="tr-review-case" key={test.testId}>
                            <div className="tr-review-case-main">
                              <strong>
                                C{test.caseId} · {test.title}
                              </strong>
                              <span>
                                {test.latestResultId ? `Result ${test.latestResultId}` : t.reviewNoResult}
                                {test.elapsed ? ` · ${test.elapsed}` : ''}
                              </span>
                              <div className="tr-review-case-meta">
                                <span>{test.assigneeName || t.unassigned}</span>
                                <span>{test.defects || t.reviewNoDefects}</span>
                              </div>
                            </div>
                            <div className="tr-review-case-side">
                              <span className={`tr-badge tr-chip-${statusTone(test.status)}`}>{test.status}</span>
                              {hasAttachments ? (
                                <button
                                  className={`tr-evidence-pill ${evidenceClass(test.evidenceStatus)} tr-evidence-pill-btn ${isOpen ? 'is-open' : ''}`}
                                  type="button"
                                  aria-expanded={isOpen}
                                  onClick={() => setOpenTestId(isOpen ? null : test.testId)}
                                >
                                  {evidenceLabel(test.evidenceStatus, test.attachments.length, t)}
                                  <span className="tr-evidence-chev" aria-hidden="true">
                                    ▾
                                  </span>
                                </button>
                              ) : (
                                <span className={`tr-evidence-pill ${evidenceClass(test.evidenceStatus)}`}>
                                  {evidenceLabel(test.evidenceStatus, test.attachments.length, t)}
                                </span>
                              )}
                              {test.latestResultId ? (
                                <EvidenceUpload target={{ kind: 'result', id: test.latestResultId }} onUploaded={onRetry} t={t} />
                              ) : test.runId && test.caseId ? (
                                <EvidenceUpload target={{ kind: 'pass', runId: test.runId, caseId: test.caseId }} onUploaded={onRetry} t={t} />
                              ) : (
                                <span className="tr-evidence-upload-disabled" title={t.evidenceUploadNoResult}>
                                  {t.evidenceUpload}
                                </span>
                              )}
                            </div>
                            {hasAttachments && isOpen ? <AttachmentPanel attachments={test.attachments} t={t} /> : null}
                          </article>
                        );
                      })
                    ) : (
                      <div className="tr-dashboard-state">{t.reviewNoTestsForFilter}</div>
                    )}
                  </div>
                </section>
              </div>

              <div className="tr-review-note">{t.reviewRuleNote}</div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
