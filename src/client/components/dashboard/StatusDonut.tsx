import type { TrStatusDistribution } from '../../../shared/contracts';
import { STATUS_ORDER, statusTone, TONE_COLORS } from './status';

interface StatusDonutProps {
  distribution: TrStatusDistribution;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  /** Overrides the center number (defaults to total test count), e.g. a pass-rate "%". */
  centerValue?: string;
}

/** Pure-SVG donut of a status distribution. No chart dependency. */
export function StatusDonut({ distribution, size = 132, thickness = 16, centerLabel, centerValue }: StatusDonutProps) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  // ordered, non-zero segments (+ any unknown/custom buckets after the known ones)
  const known = STATUS_ORDER.filter((name) => (distribution[name] || 0) > 0).map((name) => ({ name, value: distribution[name] }));
  const extra = Object.keys(distribution)
    .filter((name) => !STATUS_ORDER.includes(name as (typeof STATUS_ORDER)[number]) && distribution[name] > 0)
    .map((name) => ({ name, value: distribution[name] }));
  const segments = [...known, ...extra];
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  let offset = 0;
  return (
    <div className="tr-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Status distribution">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef1f5" strokeWidth={thickness} />
          {total > 0 &&
            segments.map((segment) => {
              const fraction = segment.value / total;
              const length = fraction * circumference;
              const circle = (
                <circle
                  key={segment.name}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={TONE_COLORS[statusTone(segment.name)] || TONE_COLORS.unknown}
                  strokeWidth={thickness}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return circle;
            })}
        </g>
      </svg>
      <div className="tr-donut-center">
        <strong>{centerValue ?? total}</strong>
        {centerLabel ? <span>{centerLabel}</span> : null}
      </div>
    </div>
  );
}
