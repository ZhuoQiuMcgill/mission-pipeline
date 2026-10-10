// model_config.json (design 9.4): per seat, the provider, model and effort; and the prices
// the metering proxy needs to bound and settle every model request (6.5 "计量代理").
//
// Prices are in dollars per million tokens, which is numerically micro-dollars per token:
// tokens x price = micro-dollars. The defaults follow the Claude API pricing table (cached
// 2026-10-06 by the claude-api reference); cache writes cost 1.25x (5 min) or 2x (1 h) the
// input price; cache reads as listed. A model with a long-context tier (Claude Haiku 5.5,
// prompts above 100K tokens) is bounded by its higher tier. The file is user-editable: the
// PM changes it on request (9.4) and new seats pick it up.
//
// UNCONFIRMED: the default prices and toolOverheadTokens (4096, an assumption) await the
// maintainer's confirmation. Only claude-haiku-5-5 has been checked: in the live run its
// settled cost matched the SDK's own cost computation (cache writes at the 1-hour rate).

import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SeatModel {
  readonly provider: 'anthropic';
  readonly model: string;
  readonly effort?: Effort;
  /** Caps max_tokens of the seat's requests (CLAUDE_CODE_MAX_OUTPUT_TOKENS); also caps each reservation. */
  readonly maxOutputTokens?: number;
}

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWrite5mMultiplier: number;
  readonly cacheWrite1hMultiplier: number;
  /** A higher tier for prompts above `aboveInputTokens` (input incl. cache) tokens. */
  readonly longContext?: {
    readonly aboveInputTokens: number;
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cacheReadPerMTok: number;
  };
}

export interface ModelConfig {
  readonly format: 'mp4.model-config.v1';
  readonly seats: Readonly<Record<string, SeatModel>>;
  readonly metering: {
    /** The fixed input the model service adds for tool use (its tool system prompt), in tokens. */
    readonly toolOverheadTokens: number;
    /** Output bound for a request that names no max_tokens. */
    readonly defaultMaxOutputTokens: number;
    readonly prices: Readonly<Record<string, ModelPrice>>;
  };
}

const std = (input: number, output: number, cacheRead: number): ModelPrice => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: cacheRead,
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2,
});

export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': std(10, 50, 0.25),
  'claude-mythos-5-1': std(10, 50, 0.25),
  'claude-fable-5': std(10, 50, 1),
  'claude-opus-5-5': std(4, 20, 0.2),
  'claude-opus-5': std(5, 25, 0.5),
  'claude-opus-4-8': std(5, 25, 0.5),
  'claude-opus-4-7': std(5, 25, 0.5),
  'claude-opus-4-6': std(5, 25, 0.5),
  'claude-sonnet-5-5': std(2, 10, 0.2),
  'claude-sonnet-5': std(2, 10, 0.2),
  'claude-sonnet-4-6': std(3, 15, 0.3),
  'claude-haiku-5-5': { ...std(0.1, 0.5, 0.01), longContext: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05 } },
  'claude-haiku-4-5': std(1, 5, 0.1),
};

/** Default prices checked against an independent source (see the header); the rest are unconfirmed. */
export const CONFIRMED_PRICES: ReadonlySet<string> = new Set(['claude-haiku-5-5']);

const DEFAULT_SEAT: SeatModel = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', maxOutputTokens: 32_000 };

/**
 * The default configuration: every seat of design 2 (the registry's SeatName keys,
 * src/seat/cards/registry.ts) on the same model. A model_config.json that does not name a seat
 * leaves that seat on this default (seatModelFor).
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  format: 'mp4.model-config.v1',
  seats: {
    calibrator: DEFAULT_SEAT,
    architect: DEFAULT_SEAT,
    secretary: DEFAULT_SEAT,
    constructor: DEFAULT_SEAT,
    reviewer: DEFAULT_SEAT,
    researcher: DEFAULT_SEAT,
    crititor: DEFAULT_SEAT,
    auditor: DEFAULT_SEAT,
  },
  metering: { toolOverheadTokens: 4_096, defaultMaxOutputTokens: 128_000, prices: DEFAULT_PRICES },
};

const price = z.number().finite().nonnegative();
const multiplier = z.number().finite().min(1);

const PriceSchema = z
  .object({
    inputPerMTok: price,
    outputPerMTok: price,
    cacheReadPerMTok: price,
    cacheWrite5mMultiplier: multiplier,
    cacheWrite1hMultiplier: multiplier,
    longContext: z
      .object({
        aboveInputTokens: z.number().int().positive(),
        inputPerMTok: price,
        outputPerMTok: price,
        cacheReadPerMTok: price,
      })
      .strict()
      .optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    format: z.literal('mp4.model-config.v1'),
    seats: z.record(
      z.string(),
      z
        .object({
          provider: z.literal('anthropic'),
          model: z.string().min(1),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
          maxOutputTokens: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    metering: z
      .object({
        toolOverheadTokens: z.number().int().nonnegative().optional(),
        defaultMaxOutputTokens: z.number().int().positive().optional(),
        /** Merged over DEFAULT_PRICES: a file names only the prices it changes or adds. */
        prices: z.record(z.string(), PriceSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export class ModelConfigError extends Error {
  override readonly name = 'ModelConfigError';
}

/**
 * Parses and validates model_config.json (code review r1 finding 11): every price finite and
 * non-negative, multipliers at least 1, no unknown keys, and every seat's model priced (a seat
 * whose requests cannot be bounded would only be refused later, request by request).
 */
export function parseModelConfig(x: unknown): ModelConfig {
  const r = ConfigSchema.safeParse(x);
  if (!r.success) throw new ModelConfigError(`model_config.json: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const c = r.data;
  const d = DEFAULT_MODEL_CONFIG.metering;
  const prices = { ...DEFAULT_PRICES, ...((c.metering?.prices ?? {}) as Record<string, ModelPrice>) };
  for (const [seat, m] of Object.entries(c.seats)) {
    if (prices[m.model] === undefined) throw new ModelConfigError(`model_config.json: the ${seat} seat's model ${JSON.stringify(m.model)} has no price`);
  }
  return {
    format: c.format,
    seats: c.seats as ModelConfig['seats'],
    metering: {
      toolOverheadTokens: c.metering?.toolOverheadTokens ?? d.toolOverheadTokens,
      defaultMaxOutputTokens: c.metering?.defaultMaxOutputTokens ?? d.defaultMaxOutputTokens,
      prices,
    },
  };
}

export function loadModelConfig(path: string): ModelConfig {
  return parseModelConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * 6.5 "输入按该模型各档输入单价中最高的一档计（含缓存写入的单价）": the highest price an input
 * token can cost, over EVERY tier the configuration allows (plain input, both cache-write
 * tiers, cache reads, and the same for the long-context tier), and the highest output price.
 * No ordering between the tiers is assumed: a configuration may price cache reads above input.
 */
export function boundPrices(p: ModelPrice): { readonly input: number; readonly output: number } {
  const tierInputs = (input: number, cacheRead: number): number[] => [input, input * p.cacheWrite5mMultiplier, input * p.cacheWrite1hMultiplier, cacheRead];
  const inputs = [...tierInputs(p.inputPerMTok, p.cacheReadPerMTok), ...(p.longContext ? tierInputs(p.longContext.inputPerMTok, p.longContext.cacheReadPerMTok) : [])];
  return {
    input: Math.max(...inputs),
    output: Math.max(p.outputPerMTok, p.longContext?.outputPerMTok ?? 0),
  };
}

/**
 * 6.5: the upper bound of one request, before it is forwarded. Input: the request body in
 * bytes (every token is at least one byte, and seat requests carry only text) plus the fixed
 * tool overhead, at the highest input price including cache writes. Output: max_tokens
 * (thinking included), at the output price. Rounded up to whole micro-dollars.
 */
export function upperBoundMicros(cfg: ModelConfig, model: string, bodyBytes: number, maxTokens: number | null): number {
  const p = cfg.metering.prices[model];
  if (p === undefined) throw new RangeError(`no price for model ${model}`);
  const b = boundPrices(p);
  const input = (bodyBytes + cfg.metering.toolOverheadTokens) * b.input;
  const output = (maxTokens ?? cfg.metering.defaultMaxOutputTokens) * b.output;
  return Math.ceil(input + output);
}

/** The usage block of a Messages API response (message_start / message_delta / JSON body). */
export interface ApiUsage {
  readonly input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation?: { readonly ephemeral_5m_input_tokens?: number; readonly ephemeral_1h_input_tokens?: number };
}

const COUNTERS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const;

function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

/**
 * 6.5 (code review r1 finding 9): a usage block is FINAL only when it is complete and
 * well-typed: all four counters present as non-negative integers, and a cache-write TTL
 * breakdown, when given, made of counts that add up to the cache-write total. Anything else
 * (missing counters, nulls, strings, a breakdown that does not sum) is not a usage the
 * settlement may trust: the request is settled at its reservation. Returns the problems.
 */
export function usageProblems(u: unknown): string[] {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return ['usage is not an object'];
  const o = u as Record<string, unknown>;
  const out: string[] = [];
  for (const k of COUNTERS) if (!isCount(o[k])) out.push(`${k} is ${o[k] === undefined ? 'missing' : `not a count (${JSON.stringify(o[k])})`}`);
  const cc = o['cache_creation'];
  if (cc !== undefined && cc !== null) {
    if (typeof cc !== 'object' || Array.isArray(cc)) out.push('cache_creation is not an object');
    else {
      const b = cc as Record<string, unknown>;
      const parts = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const;
      for (const k of parts) if (b[k] !== undefined && !isCount(b[k])) out.push(`cache_creation.${k} is not a count`);
      if (parts.every((k) => b[k] === undefined)) out.push('cache_creation names no TTL tier');
      const sum = parts.reduce((n, k) => n + (isCount(b[k]) ? b[k] : 0), 0);
      if (isCount(o['cache_creation_input_tokens']) && sum !== o['cache_creation_input_tokens']) {
        out.push(`cache_creation tiers add up to ${sum}, not to cache_creation_input_tokens ${o['cache_creation_input_tokens']}`);
      }
    }
  }
  return out;
}

/**
 * The cost of a request from the usage the model service reported. Cache writes are priced
 * by their TTL breakdown when given; without it, at the 1-hour rate (the higher one).
 */
export function usageMicros(cfg: ModelConfig, model: string, u: ApiUsage): number {
  const p = cfg.metering.prices[model];
  if (p === undefined) throw new RangeError(`no price for model ${model}`);
  const input = u.input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const long = p.longContext !== undefined && input + write + read > p.longContext.aboveInputTokens;
  const inPrice = long ? (p.longContext as NonNullable<ModelPrice['longContext']>).inputPerMTok : p.inputPerMTok;
  const outPrice = long ? (p.longContext as NonNullable<ModelPrice['longContext']>).outputPerMTok : p.outputPerMTok;
  const readPrice = long ? (p.longContext as NonNullable<ModelPrice['longContext']>).cacheReadPerMTok : p.cacheReadPerMTok;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens;
  const writeCost =
    w5 !== undefined || w1 !== undefined
      ? (w5 ?? 0) * inPrice * p.cacheWrite5mMultiplier + (w1 ?? 0) * inPrice * p.cacheWrite1hMultiplier
      : write * inPrice * p.cacheWrite1hMultiplier;
  return Math.ceil(input * inPrice + writeCost + read * readPrice + output * outPrice);
}

/**
 * The model of one seat (9.4: model_config.json keys are the seats of design 2): the file's
 * entry, or the default configuration's when the file does not name the seat. Null when
 * neither names it (an unknown seat).
 */
export function seatModelFor(config: ModelConfig, seat: string): { readonly model: SeatModel; readonly source: 'config' | 'default' } | null {
  const own = Object.hasOwn(config.seats, seat) ? config.seats[seat] : undefined;
  if (own !== undefined) return { model: own, source: 'config' };
  const d = Object.hasOwn(DEFAULT_MODEL_CONFIG.seats, seat) ? DEFAULT_MODEL_CONFIG.seats[seat] : undefined;
  return d !== undefined ? { model: d, source: 'default' } : null;
}
