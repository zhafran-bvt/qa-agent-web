import { useState } from 'react';
import { parseBddScenario, serializeBddScenario, type BddParts, type BddStepSection } from '../lib/bdd';
import { uiText, type UiLanguage } from '../i18n';

interface BddEditorProps {
  value: string;
  lang: UiLanguage;
  onChange: (next: string) => void;
}

export function BddEditor({ value, lang, onChange }: BddEditorProps) {
  const t = uiText[lang].review;
  const [rawMode, setRawMode] = useState(false);
  const { parts, structured } = parseBddScenario(value);

  // Free-form (non-Gherkin) content, or explicit raw mode → never lose data.
  if (rawMode || !structured) {
    return (
      <div className="bdd-editor">
        <textarea
          className="code-area review-textarea"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {structured ? (
          <button type="button" className="link-button" onClick={() => setRawMode(false)}>
            {t.bddEditStructured}
          </button>
        ) : null}
      </div>
    );
  }

  const emit = (next: BddParts) => onChange(serializeBddScenario(next));
  const setMeta = (key: 'feature' | 'scenario', next: string) => emit({ ...parts, [key]: next });
  const setStep = (section: BddStepSection, index: number, next: string) => {
    const steps = [...parts[section]];
    steps[index] = next;
    emit({ ...parts, [section]: steps });
  };
  const addStep = (section: BddStepSection) => emit({ ...parts, [section]: [...parts[section], ''] });
  const removeStep = (section: BddStepSection, index: number) =>
    emit({ ...parts, [section]: parts[section].filter((_, idx) => idx !== index) });

  const renderSection = (section: BddStepSection, label: string) => (
    <div className="bdd-section" key={section}>
      <div className="bdd-section-head">
        <span>{label}</span>
        <span className="bdd-count">{parts[section].length}</span>
      </div>
      {parts[section].map((step, index) => (
        <div className="bdd-step" key={index}>
          <input value={step} onChange={(event) => setStep(section, index, event.target.value)} />
          <button type="button" className="bdd-step-remove" aria-label={t.bddRemoveStep} onClick={() => removeStep(section, index)}>
            {'x'}
          </button>
        </div>
      ))}
      <button type="button" className="link-button" onClick={() => addStep(section)}>
        {t.bddAddStep(label)}
      </button>
    </div>
  );

  return (
    <div className="bdd-editor">
      <div className="case-detail-grid">
        <label className="field">
          <span>{t.bddFeature}</span>
          <input value={parts.feature} onChange={(event) => setMeta('feature', event.target.value)} />
        </label>
        <label className="field">
          <span>{t.bddScenarioName}</span>
          <input value={parts.scenario} onChange={(event) => setMeta('scenario', event.target.value)} />
        </label>
      </div>
      {renderSection('given', t.bddGiven)}
      {renderSection('when', t.bddWhen)}
      {renderSection('then', t.bddThen)}
      <button type="button" className="link-button bdd-raw-toggle" onClick={() => setRawMode(true)}>
        {t.bddEditRaw}
      </button>
    </div>
  );
}
