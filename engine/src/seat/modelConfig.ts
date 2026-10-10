// model_config.json (design 9.4): per seat, the provider, model and effort; and the prices
// the metering proxy needs to bound and settle every model request (6.5 "计量代理").
//
// Prices are in dollars per million tokens, which is numerically micro-dollars per token:
// tokens x price = micro-dollars. The defaults follow the Claude API pricing table (cached
// 2026-10-06 by the claude-api reference); cache writes cost 1.25x (5 min) or 2x (1 h) the
// input price; cache reads as listed. A model with a long-context tier (Claude Haiku 5.5,
// prompts above 100K tokens; Claude Sonnet 4 and 4.5 above 200K) is bounded by its higher
// tier. The file is user-editable: the PM changes it on request (9.4) and new seats pick it up.
//
// Every Claude model is accepted (resolvePrice): an id in the table, a dated snapshot or a
// suffixed variant of one (-20250929, -v1, [1m], @20250805), an alias Claude Code accepts
// (opus, sonnet, haiku, fable), and any other claude-* id, priced at the dearest price of its
// family (or of the whole table). Over-estimating only over-counts the accounting: the bound
// of 6.5 is "the highest price the request could cost", and 4.0 has no money spend limits
// (only `unlimited`), so nothing is refused for being over-counted.
//
// UNCONFIRMED: the default prices and toolOverheadTokens (4096, an assumption) await the
// maintainer's confirmation. Only claude-haiku-5-5 has been checked: in the live run its
// settled cost matched the SDK's own cost computation (cache writes at the 1-hour rate).
// The entries for the older models (Claude 3 to Claude 4.5) follow the public Claude API
// price list and are unconfirmed in the same way.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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

/** Claude Sonnet 4 and 4.5: a long-context tier for prompts above 200K input tokens. */
const sonnet4: ModelPrice = { ...std(3, 15, 0.3), longContext: { aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5, cacheReadPerMTok: 0.6 } };

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
  // older models Claude Code still knows (public Claude API prices; unconfirmed, see the header)
  'claude-mythos-5': std(10, 50, 1),
  'claude-opus-4-5': std(5, 25, 0.5),
  'claude-opus-4-1': std(15, 75, 1.5),
  'claude-opus-4-0': std(15, 75, 1.5),
  'claude-opus-4': std(15, 75, 1.5),
  'claude-sonnet-4-5': sonnet4,
  'claude-sonnet-4-0': sonnet4,
  'claude-sonnet-4': sonnet4,
  'claude-3-7-sonnet': std(3, 15, 0.3),
  'claude-3-5-sonnet': std(3, 15, 0.3),
  'claude-3-5-haiku': std(0.8, 4, 0.08),
  'claude-3-haiku': std(0.25, 1.25, 0.03),
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

/** The seats a model_config.json configures: the keys of the default configuration (design 2). */
export const SEAT_NAMES: readonly string[] = Object.keys(DEFAULT_MODEL_CONFIG.seats);

// ---------------------------------------------------------------- price resolution

/** The Claude model families; a model id names its family as one of its dash-separated parts. */
export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;

/** What a seat model may be, for error messages and the CLI. */
export const ACCEPTED_MODELS = 'any Claude model id (claude-...), a dated snapshot (e.g. claude-sonnet-4-5-20250929), or an alias: opus, sonnet, haiku, fable';

export interface ResolvedPrice {
  readonly price: ModelPrice;
  /** The table entry the model was priced as, or `family:<family>` / `family:any-claude` for a synthetic price. */
  readonly pricedAs: string;
}

/**
 * Suffixes stripped, in this order and repeatedly, before the table is tried again: a context
 * tag (`[1m]`), a Vertex-style version (`@20250805`), a Bedrock-style version (`-v1`, `-v2:0`),
 * a snapshot date (`-20250929`).
 */
const SUFFIXES: readonly RegExp[] = [/\[[^\]]*\]$/, /@[^@]*$/, /-v\d+(?::\d+)?$/, /-\d{8}$/];

function familiesOf(id: string): string[] {
  if (!id.startsWith('claude-')) return [];
  const parts = new Set(id.split('-'));
  return MODEL_FAMILIES.filter((f) => parts.has(f));
}

/**
 * The per-field maximum of several prices. The long-context tier (when any entry has one)
 * starts at the SMALLEST threshold, and each of its fields is the maximum over every entry's
 * long-context tier AND every entry's plain tier: above that threshold a member may still be
 * charged its plain tier (its own threshold is higher), so the synthetic tier must not be
 * cheaper than either. The result is never cheaper than any entry, for the bound
 * (boundPrices) and for the settlement (usageMicros) alike.
 */
function maxPrice(list: readonly ModelPrice[]): ModelPrice | null {
  if (list.length === 0) return null;
  const max = (f: (p: ModelPrice) => number): number => Math.max(...list.map(f));
  const input = max((p) => p.inputPerMTok);
  const output = max((p) => p.outputPerMTok);
  const cacheRead = max((p) => p.cacheReadPerMTok);
  const longs = list.flatMap((p) => (p.longContext !== undefined ? [p.longContext] : []));
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWrite5mMultiplier: max((p) => p.cacheWrite5mMultiplier),
    cacheWrite1hMultiplier: max((p) => p.cacheWrite1hMultiplier),
    ...(longs.length > 0
      ? {
          longContext: {
            aboveInputTokens: Math.min(...longs.map((l) => l.aboveInputTokens)),
            inputPerMTok: Math.max(input, ...longs.map((l) => l.inputPerMTok)),
            outputPerMTok: Math.max(output, ...longs.map((l) => l.outputPerMTok)),
            cacheReadPerMTok: Math.max(cacheRead, ...longs.map((l) => l.cacheReadPerMTok)),
          },
        }
      : {}),
  };
}

/**
 * The price of a model id (6.5), used wherever a price is needed (the configuration check, the
 * request bound, the settlement, the self-check's choice of model):
 *   1. the table entry with exactly this id;
 *   2. the id lowercased and with its suffixes stripped one by one (SUFFIXES), each tried
 *      against the table (claude-haiku-4-5-20251001 → claude-haiku-4-5);
 *   3. an alias (opus, sonnet, haiku, fable, mythos; after stripping, so opus[1m] too): the
 *      dearest price of that family in the table (pricedAs `family:opus`);
 *   4. any other claude-* id that names a family as one of its parts (claude-opus-6,
 *      claude-3-opus, claude-mythos-preview): the dearest price of that family (of each
 *      family it names);
 *   5. any other claude-* id: the dearest price of the whole table (`family:any-claude`).
 * Null for anything else: the provider is Anthropic only, and such a request cannot be bounded.
 * The fallbacks are conservative on purpose: see the header.
 */
export function resolvePrice(prices: Readonly<Record<string, ModelPrice>>, model: string): ResolvedPrice | null {
  const exact = (id: string): ResolvedPrice | null => (Object.hasOwn(prices, id) ? { price: prices[id] as ModelPrice, pricedAs: id } : null);
  const hit = exact(model);
  if (hit !== null) return hit;
  let base = model.trim().toLowerCase();
  const lowered = exact(base);
  if (lowered !== null) return lowered;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of SUFFIXES) {
      const next = base.replace(re, '');
      if (next === base || next === '') continue;
      base = next;
      changed = true;
      const r = exact(base);
      if (r !== null) return r;
    }
  }
  const families: string[] = (MODEL_FAMILIES as readonly string[]).includes(base) ? [base] : familiesOf(base);
  if (families.length === 0 && !base.startsWith('claude-')) return null;
  if (families.length > 0) {
    const members = Object.keys(prices).filter((k) => familiesOf(k.toLowerCase()).some((f) => families.includes(f)));
    const p = maxPrice(members.map((k) => prices[k] as ModelPrice));
    if (p !== null) return { price: p, pricedAs: `family:${families.join('+')}` };
    // a family the table has no entry of: priced as any Claude model
  }
  const all = maxPrice(Object.values(prices));
  return all === null ? null : { price: all, pricedAs: 'family:any-claude' };
}

function mustResolve(cfg: ModelConfig, model: string): ModelPrice {
  const r = resolvePrice(cfg.metering.prices, model);
  if (r === null) throw new RangeError(`no price for model ${model}`);
  return r.price;
}

/**
 * Sets every seat of a model_config.json document (the default seats and any other seat the
 * document names) to the given model, effort or output cap; the rest of the document is kept.
 * A seat the document does not name starts from the default seat. Not validated here: the
 * caller validates the result with parseModelConfig before writing it.
 */
export function withEverySeat(raw: Readonly<Record<string, unknown>>, change: { readonly model?: string; readonly effort?: Effort; readonly maxOutputTokens?: number }): Record<string, unknown> {
  const own = (raw['seats'] ?? {}) as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const seats: Record<string, Record<string, unknown>> = {};
  for (const seat of [...SEAT_NAMES, ...Object.keys(own).filter((k) => !SEAT_NAMES.includes(k))]) {
    const prev: Record<string, unknown> = Object.hasOwn(own, seat) ? { ...own[seat] } : { ...(DEFAULT_MODEL_CONFIG.seats[seat] as SeatModel | undefined) };
    seats[seat] = {
      ...prev,
      provider: 'anthropic',
      ...(change.model !== undefined ? { model: change.model } : {}),
      ...(change.effort !== undefined ? { effort: change.effort } : {}),
      ...(change.maxOutputTokens !== undefined ? { maxOutputTokens: change.maxOutputTokens } : {}),
    };
  }
  return { ...raw, format: raw['format'] ?? DEFAULT_MODEL_CONFIG.format, seats };
}

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
 * non-negative, multipliers at least 1, no unknown keys, and every seat's model priced by
 * resolvePrice (any Claude model; a seat whose requests cannot be bounded would only be
 * refused later, request by request).
 */
export function parseModelConfig(x: unknown): ModelConfig {
  const r = ConfigSchema.safeParse(x);
  if (!r.success) throw new ModelConfigError(`model_config.json: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const c = r.data;
  const d = DEFAULT_MODEL_CONFIG.metering;
  const prices = { ...DEFAULT_PRICES, ...((c.metering?.prices ?? {}) as Record<string, ModelPrice>) };
  for (const [seat, m] of Object.entries(c.seats)) {
    if (resolvePrice(prices, m.model) === null) {
      throw new ModelConfigError(`model_config.json: the ${seat} seat's model ${JSON.stringify(m.model)} has no price: a seat model is ${ACCEPTED_MODELS} (or a model priced under metering.prices)`);
    }
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
 * (thinking included), at the output price. Rounded up to whole micro-dollars. The model is
 * priced by resolvePrice; a model it cannot price throws a RangeError.
 */
export function upperBoundMicros(cfg: ModelConfig, model: string, bodyBytes: number, maxTokens: number | null): number {
  const b = boundPrices(mustResolve(cfg, model));
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
 * by their TTL breakdown when given; without it, at the 1-hour rate (the higher one). The
 * model is priced by resolvePrice, as for the bound.
 */
export function usageMicros(cfg: ModelConfig, model: string, u: ApiUsage): number {
  const p = mustResolve(cfg, model);
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
