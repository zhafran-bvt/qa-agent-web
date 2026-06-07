// Shared status tone + colour mapping for the TestRail dashboard.
export const STATUS_ORDER = ['Passed', 'Failed', 'Blocked', 'Retest', 'Untested', 'Obsolete'] as const;

const STATUS_TONES: Record<string, string> = {
  Passed: 'passed',
  Failed: 'failed',
  Blocked: 'blocked',
  Retest: 'retest',
  Untested: 'untested',
  Obsolete: 'obsolete',
};

export function statusTone(name: string): string {
  return STATUS_TONES[name] || 'unknown';
}

export const TONE_COLORS: Record<string, string> = {
  passed: '#15803d',
  failed: '#be123c',
  blocked: '#b45309',
  retest: '#6d28d9',
  untested: '#cbd5e1',
  obsolete: '#64748b',
  unknown: '#94a3b8',
};
