// Conservative stop detection in the user's words (design 6.4: in force at once, wider rather than narrower; 3.1).
//
// The PM's prompt hook runs this on every user message. Stop, forbid and withdraw
// phrases in Chinese and English trigger a stop at once, without asking the user
// again. False positives are accepted by design (risk 9: the PM can narrow or
// release the stop right away); misses are not, so every rule leans towards
// detecting. Scopes are conservative:
//  - a capability-specific form ("不许联网") restricts every unit with that capability,
//    but only for capabilities units are actually tagged with (`tagged`); any other
//    capability word widens to the generic scope;
//  - generic forms ("停") restrict the related mission's production and delivery, or
//    everything when the mission is unclear: a mission scope only when the words name
//    exactly one known mission.

import type { MissionId } from '../common/ids.ts';
import type { StopScope } from '../ledger/stops.ts';

interface Rule {
  readonly id: string;
  readonly re: RegExp;
}

/** Chinese stop, forbid and withdraw phrases (users may type Chinese). "停" alone already covers 停止, 暂停, 停下, 停掉, 叫停. */
const ZH_RULES: readonly Rule[] = [
  { id: '停', re: /停/u },
  { id: '别做', re: /别(再|做|弄|动|搞|改|跑|继续|干|碰|提交|推|合并|发|上传|装|删)/u },
  { id: '不要', re: /(?<!要)不要/u },
  { id: '不要再', re: /不要再/u },
  { id: '撤回', re: /撤(回|销|掉)/u },
  { id: '取消', re: /取消/u },
  { id: '不许', re: /不(许|准|可以|得|能再)/u },
  { id: '禁止', re: /禁止|严禁/u },
  { id: '中止', re: /中止|终止|中断|打住|住手/u },
  { id: '回滚', re: /回滚|退回去|恢复原样/u },
  { id: '算了', re: /算了|先别/u },
];

/** English phrases, as whole words (case-insensitive). */
const EN_RULES: readonly Rule[] = [
  { id: 'stop', re: /\bstop(s|ped|ping)?\b/i },
  { id: 'halt', re: /\bhalt(s|ed|ing)?\b/i },
  { id: 'cancel', re: /\bcancel(s|led|ed|ling|ing)?\b/i },
  { id: 'abort', re: /\babort(s|ed|ing)?\b/i },
  { id: 'pause', re: /\bpause[sd]?\b/i },
  { id: "don't", re: /\b(don'?t|do\s+not|doesn'?t|does\s+not)\b/i },
  { id: 'must not', re: /\b(must\s*n[o']t|mustn'?t|shall\s+not|shan'?t|never\s+again|no\s+more|not\s+allowed|forbid(den|s)?|prohibit(ed|s)?)\b/i },
  { id: 'revert', re: /\b(revert(s|ed|ing)?|roll\s*back|rollback|undo)\b/i },
  { id: 'withdraw', re: /\b(withdraw(n|s)?|retract(ed|s)?)\b/i },
  { id: 'kill', re: /\b(kill|terminate|freeze|quit)\b/i },
];

/** Capability words. `cap`: the scope tag units carry for it. */
const CAPABILITY_RULES: ReadonlyArray<{ readonly cap: string; readonly re: RegExp }> = [
  { cap: 'network', re: /联网|上网|网络|外网|互联网|下载|访问网|\b(internet|network|online|web|download|http|curl|wget)\b/iu },
  { cap: 'delivery', re: /交付|落地|合并|推送|发布|\b(deliver(y|ies)?|land(ing)?|merge|push|release|publish)\b/iu },
  { cap: 'run-command', re: /运行命令|执行命令|跑命令|\b(run\s+commands?|shell)\b/iu },
  { cap: 'paid-model', re: /花钱|付费|烧钱|\b(spend(ing)?|paid\s+models?)\b/iu },
];

/**
 * Capabilities units are reliably tagged with. None today: the scheduler and the landing tag
 * units and intents with the capabilities on their cards, and no shared vocabulary exists yet,
 * so a capability stop could match nothing; every capability form widens to the generic scope
 * (wider rather than narrower) until the installation lists tagged capabilities (CliConfig.taggedCapabilities).
 */
export const DEFAULT_TAGGED_CAPABILITIES: readonly string[] = [];

export interface StopDetection {
  readonly detected: boolean;
  /** Which rules matched (for the PM's context). */
  readonly triggers: readonly string[];
  /** A capability named next to the stop phrase, if any. */
  readonly capability: string | null;
}

export function detectStop(text: string): StopDetection {
  const t = text.normalize('NFKC');
  const triggers: string[] = [];
  for (const r of [...ZH_RULES, ...EN_RULES]) if (r.re.test(t)) triggers.push(r.id);
  if (triggers.length === 0) return { detected: false, triggers, capability: null };
  let capability: string | null = null;
  const caps = CAPABILITY_RULES.filter((c) => c.re.test(t)).map((c) => c.cap);
  // Exactly one capability named: a capability-specific form. Several, or none: generic.
  if (caps.length === 1) capability = caps[0]!;
  return { detected: true, triggers, capability };
}

export interface ScopeDecision {
  readonly scope: StopScope;
  /** Why this scope, in the PM's words. */
  readonly why: string;
}

/** The known missions the words name as a whole token ("m1" is not named by "m10" or "am1"). */
export function namedMissions(text: string, known: readonly string[]): string[] {
  const t = text.normalize('NFKC');
  const esc = (m: string): string => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...new Set(known.filter((m) => m.length > 0 && new RegExp(`(?<![A-Za-z0-9_-])${esc(m)}(?![A-Za-z0-9_-])`, 'u').test(t)))];
}

/**
 * The conservative scope (6.4): a capability scope for a tagged capability; else the one
 * mission the words name, or the only related one; else everything. A mission scope only
 * when `complete` (every query about the missions answered): never narrow on doubt.
 */
export function stopScopeFor(
  text: string,
  d: StopDetection,
  o: { readonly knownMissions?: readonly string[]; readonly openMissions?: readonly string[]; readonly complete?: boolean; readonly tagged?: readonly string[] } = {},
): ScopeDecision {
  const tagged = o.tagged ?? DEFAULT_TAGGED_CAPABILITIES;
  if (d.capability !== null && tagged.includes(d.capability)) {
    return { scope: { kind: 'capability', capability: d.capability }, why: `a stop for the capability "${d.capability}": restricts every unit with it` };
  }
  const named = namedMissions(text, o.knownMissions ?? []);
  const widened = d.capability !== null ? ` (units are not reliably tagged with the capability "${d.capability}": widened)` : '';
  if (o.complete !== true) {
    return {
      scope: { kind: 'all' },
      why: `a generic stop, and the ledger did not say in time which missions are related: restricts everything${named.length > 0 ? ` (including ${named.join(', ')})` : ''}${widened}`,
    };
  }
  if (named.length === 1) {
    return { scope: { kind: 'mission', mission: named[0] as MissionId }, why: `a generic stop: restricts all production and delivery of mission ${named[0]}${widened}` };
  }
  const open = o.openMissions ?? [];
  if (named.length === 0 && open.length === 1) {
    return { scope: { kind: 'mission', mission: open[0] as MissionId }, why: `a generic stop: restricts all production and delivery of the related mission, ${open[0]} (the only one open or with work)${widened}` };
  }
  return {
    scope: { kind: 'all' },
    why: `a generic stop, the mission is unclear: restricts everything${named.length > 1 ? ` (${named.length} missions named)` : ''}${widened}`,
  };
}

export function describeScope(s: StopScope): string {
  switch (s.kind) {
    case 'all':
      return 'everything';
    case 'mission':
      return `mission ${s.mission}`;
    case 'capability':
      return `capability ${s.capability}`;
  }
}

/** Parse a `--scope` value: all | mission:<id> | capability:<name>. */
export function parseScope(v: string): StopScope | null {
  if (v === 'all') return { kind: 'all' };
  const m = /^(mission|capability):(.+)$/.exec(v);
  if (!m) return null;
  if (m[1] === 'mission') return { kind: 'mission', mission: m[2] as MissionId };
  return { kind: 'capability', capability: m[2]! };
}

/** `inner` restricts nothing that `outer` does not (narrowing, 6.4). */
export function scopeWithin(inner: StopScope, outer: StopScope): boolean {
  if (outer.kind === 'all') return true;
  if (outer.kind === 'mission') return inner.kind === 'mission' && inner.mission === outer.mission;
  return inner.kind === 'capability' && inner.capability === outer.capability;
}

/** The user's words kept with a stop: bounded (a stop request carries at most 64 KiB; the full text is booked as user words). */
export function stopWords(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
