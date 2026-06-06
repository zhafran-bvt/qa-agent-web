import { useEffect, useState } from 'react';
import type { TestrailCredentialsStatus } from '../../shared/contracts';
import { clearTestrailCredentials, loadTestrailCredentials, saveTestrailCredentials } from '../api';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface TestRailAccountModalProps {
  lang: UiLanguage;
  onClose: () => void;
}

export function TestRailAccountModal({ lang, onClose }: TestRailAccountModalProps) {
  const t = uiText[lang].trAccount;
  const [status, setStatus] = useState<TestrailCredentialsStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadTestrailCredentials()
      .then((res) => {
        if (cancelled) return;
        setStatus(res);
        setEmail(res.user || '');
        setEditing(res.available && !res.configured);
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false, configured: false, user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await saveTestrailCredentials({ user: email.trim(), apiKey: apiKey.trim() });
      setStatus(res);
      setApiKey('');
      setEditing(false);
    } catch (err) {
      setError((err as Error).message || t.saveError);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError('');
    try {
      const res = await clearTestrailCredentials();
      setStatus(res);
      setApiKey('');
      setEditing(true);
    } catch (err) {
      setError((err as Error).message || t.saveError);
    } finally {
      setBusy(false);
    }
  }

  const available = status?.available ?? true;
  const configured = status?.configured ?? false;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card tr-account-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tr-account-head">
          <div>
            <h3>{t.title}</h3>
            <p>{configured && !editing ? t.subtitleConnected : t.subtitle}</p>
          </div>
          <button className="tr-account-x" type="button" aria-label={t.close} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="tr-account-body">
          {!status ? (
            <div className="home-muted">…</div>
          ) : !available ? (
            <div className="note note-warn">{t.unavailable}</div>
          ) : configured && !editing ? (
            <div className="tr-account-conn">
              <span className="tr-account-dot" aria-hidden="true">✓</span>
              <div>
                <strong>{t.connectedAs(status.user || '')}</strong>
                <div className="tr-account-sub">{status.user} · {t.storedNote}</div>
              </div>
            </div>
          ) : (
            <form className="tr-account-form" onSubmit={save}>
              {!configured ? <div className="note note-info">{t.sharedNote}</div> : null}
              <label className="field">
                <span>{t.emailLabel}</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
              </label>
              <label className="field">
                <span>{t.apiKeyLabel}</span>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" required />
                <small className="tr-account-hint">{t.apiKeyHint}</small>
              </label>
              {error ? <div className="note note-warn">{error}</div> : null}
              <div className="tr-account-actions">
                <button className="button button-secondary button-small" type="button" onClick={onClose}>
                  {t.cancel}
                </button>
                <button className="button button-primary button-small" type="submit" disabled={busy || !email.trim() || !apiKey.trim()}>
                  {busy ? t.saving : t.verifySave}
                </button>
              </div>
            </form>
          )}
        </div>

        {available && configured && !editing ? (
          <div className="tr-account-foot">
            <button className="button button-danger button-small" type="button" disabled={busy} onClick={clear}>
              {t.clear}
            </button>
            <button className="button button-primary button-small" type="button" onClick={() => setEditing(true)}>
              {t.update}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
