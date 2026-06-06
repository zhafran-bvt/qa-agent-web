import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface GuideViewProps {
  lang: UiLanguage;
}

export function GuideView({ lang }: GuideViewProps) {
  const g = uiText[lang].guide;

  return (
    <div className="guide">
      <div className="guide-content">
        <header className="guide-hero">
          <h1>{g.title}</h1>
          <p>{g.intro}</p>
        </header>

        <section className="guide-card" id="guide-overview">
          <h2><span className="guide-ic" aria-hidden="true">◎</span> {g.secOverview}</h2>
          <p className="guide-lead">{g.overviewLead}</p>
          <div className="guide-pipe">
            {g.pipeline.map((node, index) => (
              <div className="guide-pipe-wrap" key={node.title}>
                <div className="guide-pnode">
                  <b>{node.title}</b>
                  <span>{node.body}</span>
                </div>
                {index < g.pipeline.length - 1 ? <span className="guide-arrow" aria-hidden="true">→</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="guide-card" id="guide-workflow">
          <h2><span className="guide-ic" aria-hidden="true">✦</span> {g.secWorkflow}</h2>
          <p className="guide-lead">{g.workflowLead}</p>
          <div className="guide-steps">
            {g.steps.map((step, index) => (
              <div className="guide-step" key={step.title}>
                <span className="guide-step-n">{index + 1}</span>
                <div>
                  <b>{step.title}</b>
                  <p>{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="guide-card" id="guide-testrail">
          <h2><span className="guide-ic" aria-hidden="true">▤</span> {g.secTestrail}</h2>
          <p className="guide-lead">{g.testrailLead}</p>
          <div className="guide-model">
            {g.model.map((col) => (
              <div className="guide-mcol" key={col.tag}>
                <span className="guide-tag">{col.tag}</span>
                <b>{col.name}</b>
                <span className="guide-mbody">{col.body}</span>
              </div>
            ))}
          </div>
          <ul className="guide-ul">
            {g.testrailPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>

        <section className="guide-card" id="guide-credits">
          <h2><span className="guide-ic" aria-hidden="true">●</span> {g.secCredits}</h2>
          <p className="guide-lead">{g.creditsBody}</p>
        </section>

        <section className="guide-card" id="guide-tips">
          <h2><span className="guide-ic" aria-hidden="true">★</span> {g.secTips}</h2>
          <ul className="guide-ul">
            {g.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
