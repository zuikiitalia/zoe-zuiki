// Prezzi Anthropic per milione di token (listino aggiornato 2026-10).
// cacheRead = lettura da cache; cacheCreate = scrittura in cache con TTL 5 minuti (1.25× input).
// https://www.anthropic.com/pricing
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-5-5':    { input:  4.00, output: 20.00, cacheRead: 0.20,  cacheCreate:  5.00 },
  'claude-opus-4-7':    { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheCreate:  6.25 },
  'claude-sonnet-5-5':  { input:  2.00, output: 10.00, cacheRead: 0.20,  cacheCreate:  2.50 },
  'claude-sonnet-4-6':  { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheCreate:  3.75 },
  'claude-haiku-5-5':   { input:  0.10, output:  0.50, cacheRead: 0.01,  cacheCreate:  0.125 },
  'claude-haiku-4-5':   { input:  1.00, output:  5.00, cacheRead: 0.10,  cacheCreate:  1.25 },
};

const DEFAULT_PRICING = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 };

// Trova il listino del modello. Accetta anche ID con suffisso di data
// (es. "claude-haiku-4-5-20251001" → "claude-haiku-4-5").
export function pricingFor(model: string) {
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? PRICING[key]! : DEFAULT_PRICING;
}

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const p = pricingFor(model);
  return (
    (inputTokens        * p.input       / 1_000_000) +
    (outputTokens       * p.output      / 1_000_000) +
    (cacheReadTokens    * p.cacheRead   / 1_000_000) +
    (cacheCreationTokens * p.cacheCreate / 1_000_000)
  );
}
