import { AsyncLocalStorage } from 'node:async_hooks';

// Per-LLM-call token accounting. This is pure instrumentation: it only reads the `usage` object the
// provider already returns, never alters a request, prompt, or response — so it cannot affect AC/TC
// quality. Attribution is per async context via AsyncLocalStorage, so concurrent analyze/generate
// requests never mix their counts.

export interface LlmCallUsage {
  task: string;
  label: string;
  provider: string;
  model: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const storage = new AsyncLocalStorage<LlmCallUsage[]>();

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Record one LLM call's usage into the active capture scope. No-op when no scope is active, so calls
 * made outside a withLlmUsageCapture() block are simply not counted (never throws).
 */
export function recordLlmUsage(entry: { task: string; label: string; provider: string; model: string; usage: unknown }): void {
  const store = storage.getStore();
  if (!store) return;
  const u = (entry.usage || {}) as Record<string, any>;
  const promptTokens = num(u.prompt_tokens ?? u.promptTokens);
  const completionTokens = num(u.completion_tokens ?? u.completionTokens);
  const totalTokens = num(u.total_tokens ?? u.totalTokens) || promptTokens + completionTokens;
  // OpenAI reports cached input under prompt_tokens_details.cached_tokens; DeepSeek uses prompt_cache_hit_tokens.
  const cachedPromptTokens = num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens);
  store.push({
    task: entry.task,
    label: entry.label,
    provider: entry.provider,
    model: entry.model,
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    totalTokens,
  });
}

export async function withLlmUsageCapture<T>(fn: () => Promise<T>): Promise<{ result: T; usage: LlmCallUsage[] }> {
  const store: LlmCallUsage[] = [];
  const result = await storage.run(store, fn);
  return { result, usage: store };
}

interface TaskAggregate {
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function summarizeLlmUsage(usage: LlmCallUsage[]) {
  const byTask: Record<string, TaskAggregate> = {};
  const totals: TaskAggregate = { calls: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const u of usage) {
    totals.calls += 1;
    totals.promptTokens += u.promptTokens;
    totals.cachedPromptTokens += u.cachedPromptTokens;
    totals.completionTokens += u.completionTokens;
    totals.totalTokens += u.totalTokens;
    const t = (byTask[u.task] ||= { calls: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 });
    t.calls += 1;
    t.promptTokens += u.promptTokens;
    t.cachedPromptTokens += u.cachedPromptTokens;
    t.completionTokens += u.completionTokens;
    t.totalTokens += u.totalTokens;
  }
  const cachedPromptTokenPct = totals.promptTokens > 0 ? Math.round((totals.cachedPromptTokens / totals.promptTokens) * 100) : 0;
  return {
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    cachedPromptTokens: totals.cachedPromptTokens,
    cachedPromptTokenPct,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    byTask,
  };
}
