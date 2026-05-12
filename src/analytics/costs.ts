// Prezzi Anthropic per milione di token (aggiornati 2026-05).
// https://www.anthropic.com/pricing
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-7':    { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheCreate: 18.75 },
  'claude-opus-4-5':    { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheCreate: 18.75 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheCreate:  3.75 },
  'claude-sonnet-4-5':  { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheCreate:  3.75 },
  'claude-haiku-4-5':   { input:  0.80, output:  4.00, cacheRead: 0.08,  cacheCreate:  1.00 },
};

const DEFAULT_PRICING = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 };

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (inputTokens        * p.input       / 1_000_000) +
    (outputTokens       * p.output      / 1_000_000) +
    (cacheReadTokens    * p.cacheRead   / 1_000_000) +
    (cacheCreationTokens * p.cacheCreate / 1_000_000)
  );
}
