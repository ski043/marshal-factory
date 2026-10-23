export type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// USD per million tokens. Source: claude-api skill model table, cached 2026-10-06
// (https://docs.claude.com/en/docs/about-claude/pricing). Cache writes assume the
// 5-minute TTL at 1.25x input. Haiku 5.5 is the at-or-below-100K-prompt tier.
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export type TokenCounts = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export function priceFor(model: string | null | undefined): Price | undefined {
  if (!model) return undefined;
  const id = Object.keys(PRICES).find((key) => model.startsWith(key));
  return id ? PRICES[id] : undefined;
}

/** Spend in USD. Unknown models count as 0 so a new model never breaks the panel. */
export function costUsd(
  tokens: TokenCounts,
  model: string | null | undefined,
): number {
  const price = priceFor(model);
  if (!price) return 0;
  return (
    (tokens.input_tokens * price.input +
      tokens.output_tokens * price.output +
      tokens.cache_read_tokens * price.cacheRead +
      tokens.cache_write_tokens * price.cacheWrite) /
    1_000_000
  );
}
