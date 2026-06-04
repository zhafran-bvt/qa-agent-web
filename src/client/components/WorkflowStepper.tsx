import { uiText, type UiLanguage } from '../i18n';

export type WorkflowStepKey = 'analyze' | 'scope' | 'review' | 'approve';
export type WorkflowStepState = 'done' | 'active' | 'upcoming';

interface WorkflowStepperProps {
  lang: UiLanguage;
  steps: Array<{ key: WorkflowStepKey; state: WorkflowStepState }>;
}

// Indicator only — reflects how far the run has progressed. Not interactive.
export function WorkflowStepper({ lang, steps }: WorkflowStepperProps) {
  const t = uiText[lang].stepper;
  return (
    <ol className="workflow-stepper" aria-label={t.ariaLabel}>
      {steps.map((step, index) => (
        <li
          key={step.key}
          className={`workflow-step is-${step.state}`}
          aria-current={step.state === 'active' ? 'step' : undefined}
        >
          <span className="workflow-step-dot" aria-hidden="true">
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          <span className="workflow-step-label">{t[step.key]}</span>
        </li>
      ))}
    </ol>
  );
}
