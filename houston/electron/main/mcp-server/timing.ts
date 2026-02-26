/** Per-action timing for MCP tools. Records seconds and logs summaries. */
const totals: Record<string, number> = {};
let toolCallCount = 0;

export function record(action: string, seconds: number): void {
  totals[action] = (totals[action] ?? 0) + seconds;
}

export function timed<T>(action: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().finally(() => {
    const sec = (performance.now() - start) / 1000;
    record(action, sec);
    console.log(`[Houston MCP] ${action}: ${sec.toFixed(2)}s`);
  });
}

export function logSummary(): void {
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  if (entries.length === 0) return;
  toolCallCount++;
  const lines = entries
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `  ${k}: ${v.toFixed(1)}s`);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  console.log(`[Houston MCP] Timing summary (${toolCallCount} tool call(s)): total ${total.toFixed(1)}s`);
  console.log(lines.join("\n"));
}

export function reset(): void {
  for (const k of Object.keys(totals)) delete totals[k];
  toolCallCount = 0;
}
