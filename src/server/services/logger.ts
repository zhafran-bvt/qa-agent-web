type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface RecentIssueEntry {
  timestamp: string;
  level: 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(value: string | undefined): LogLevel {
  const candidate = String(value || '').toLowerCase();
  if (candidate === 'debug' || candidate === 'info' || candidate === 'warn' || candidate === 'error') {
    return candidate;
  }
  return 'info';
}

const ACTIVE_LEVEL = normalizeLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[ACTIVE_LEVEL];
}

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) {
        output[key] = '[redacted]';
        continue;
      }
      output[key] = sanitize(item);
    }
    return output;
  }
  return value;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const recentIssues: RecentIssueEntry[] = [];

export function getRecentIssues(limit = 20): RecentIssueEntry[] {
  return recentIssues.slice(-limit).reverse();
}

class JsonLogger implements Logger {
  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;
    const sanitizedBindings = sanitize(this.bindings) as Record<string, unknown>;
    const sanitizedFields = (fields ? sanitize(fields) : {}) as Record<string, unknown>;
    const timestamp = new Date().toISOString();
    const payload = {
      timestamp,
      level,
      message,
      ...sanitizedBindings,
      ...sanitizedFields,
    };
    if (level === 'warn' || level === 'error') {
      recentIssues.push({ timestamp, level, message, fields: sanitizedFields });
      if (recentIssues.length > 100) recentIssues.splice(0, recentIssues.length - 100);
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line);
      return;
    }
    process.stdout.write(line);
  }
}

export const logger: Logger = new JsonLogger({ service: 'qa-agent-web' });
