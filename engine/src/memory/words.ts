import { canonicalJson, sha256 } from '../common/hash.ts';
import type { BasisLineId, BasisVersionId, ContentHash, MissionId } from '../common/ids.ts';
import type { BaseRecord } from '../common/records.ts';
import type { Db } from './db.ts';
import type { ResidentEvent, WordsTag } from './events.ts';
import type { Memory, WriteTx } from './memory.ts';
import { wordsEntry } from './queries.ts';
import { notAllowed } from './resident.ts';
import { appendRecords } from './domain/facts.ts';

type Texts = {text(hash: string): string};
export interface TaggedWords {
  readonly words: string;
  readonly text: string;
  readonly revision: number;
  readonly tags: readonly (WordsTag & {inForce: boolean; fingerprint: string})[];
}

export function residentRecords<K extends ResidentEvent['kind']>(db: Db, kind: K): Extract<ResidentEvent, {kind: K}>[] {
  return (db.stmt('SELECT record FROM log WHERE kind = ? ORDER BY rev').all(kind) as {record: string}[]).map((r) => JSON.parse(r.record) as Extract<ResidentEvent, {kind: K}>);
}

export function taggedWords(db: Db, data: Texts): TaggedWords[] {
  const updates = new Map<string, {tags: readonly WordsTag[]; versions: Map<string, number>}>();
  const superseded = new Set<string>();
  for (const row of db.stmt("SELECT rev, record FROM log WHERE kind = 'user.words-tags' ORDER BY rev").all() as {rev: number; record: string}[]) {
    const r = JSON.parse(row.record) as Extract<ResidentEvent, {kind: 'user.words-tags'}>;
    const old = updates.get(r.words);
    const versions = new Map(r.tags.map((tag) => {const before = old?.tags.find((t) => t.id === tag.id); return [tag.id, before !== undefined && canonicalJson(before) === canonicalJson(tag) ? old!.versions.get(tag.id)! : Number(row.rev)];}));
    updates.set(r.words, {tags: r.tags, versions});
    for (const id of r.supersedes) superseded.add(id);
  }
  const lastScopeEnd = new Map((db.stmt("SELECT json_extract(record, '$.mission') AS mission, MAX(rev) AS rev FROM log WHERE kind = 'mission.close' GROUP BY json_extract(record, '$.mission')").all() as {mission: string; rev: number}[]).map((r) => [r.mission, Number(r.rev)]));
  const closed = new Set((db.stmt("SELECT mission FROM missions WHERE state = 'closed'").all() as {mission: string}[]).map((r) => r.mission));
  return (db.stmt('SELECT words, text, rev FROM words ORDER BY rev DESC').all() as {words: string; text: string; rev: number}[]).map((w) => {
    const update = updates.get(w.words);
    return {words: w.words, text: data.text(w.text), revision: Number(w.rev), tags: (update?.tags ?? []).map((t) => ({...t, inForce: t.type !== 'instruction' && !superseded.has(t.id) && (t.mission === null || !closed.has(t.mission)), fingerprint: sha256(canonicalJson({tag: t, revision: update?.versions.get(t.id), superseded: superseded.has(t.id), closed: t.mission !== null && closed.has(t.mission), scopeEndedAt: t.mission === null ? null : lastScopeEnd.get(t.mission) ?? null}))}))};
  });
}

/** The snapshot is checked again inside application's transaction, under the write lock. */
export function wordsAuthority(db: Db, data: Texts, id: string, mission?: string): string | null {
  const w = taggedWords(db, data).find((w) => w.words === id);
  if (w === undefined) return null;
  if (mission !== undefined && db.stmt("SELECT 1 FROM missions WHERE mission = ? AND state = 'closed'").get(mission) !== undefined) return null;
  // Untyped legacy entries remain readable and usable without migration.
  if (w.tags.length === 0) return sha256(`${id}:untyped`);
  const tags = w.tags.filter((t) => t.inForce && (t.mission === null || mission === undefined || t.mission === mission));
  return tags.length === 0 ? null : sha256(canonicalJson(tags.map((t) => t.fingerprint)));
}

export function parseTag(raw: string, text: string): Omit<WordsTag, 'id'> {
  const m = /^(principle|decision|requirement|instruction)(?:@([^:]+))?(?::([\s\S]*))?$/.exec(raw);
  if (m === null) notAllowed(`invalid tag ${raw}; use principle, decision[@mission], requirement@mission, or instruction, optionally followed by :"verbatim quote"`);
  const type = m[1] as WordsTag['type'];
  const mission = m[2] ?? null;
  if ((type === 'principle' || type === 'instruction') && mission !== null) notAllowed(`${type} is project-scoped`);
  if (type === 'requirement' && mission === null) notAllowed('a requirement tag names @mission');
  const q = m[3];
  const quote = q === undefined ? null : q.startsWith('"') && q.endsWith('"') ? q.slice(1, -1) : q;
  if (quote !== null && (quote === '' || !text.includes(quote))) notAllowed('the tag quote must occur verbatim in the words entry');
  return {type, mission, quote};
}

/** `words` (the entry it rests on) and `itemType` are 4.4 additions (G7); older callers read the rest as before. */
export interface WordsDependency {id: string; mission: string; kind: 'item' | 'constraint' | 'waiver'; line: string; key?: string; words?: string; itemType?: string}
export function wordsDependencies(db: Db, data: Texts, entries: readonly string[]): WordsDependency[] {
  const wanted = new Set(entries);
  const out = new Map<string, WordsDependency>();
  const events = db.stmt("SELECT mission, event, key, body FROM flow_events WHERE line IN ('requirements', 'plan') ORDER BY revision").all() as {mission: string; event: string; key: string; body: string}[];
  for (const e of events) {
    const b = JSON.parse(data.text(e.body)) as Record<string, any>;
    if (e.event === 'item' || e.event === 'constraint') {
      const id = String(b.line);
      out.delete(id);
      const words = b.source?.kind === 'words' ? b.source.words : b.words;
      if (wanted.has(words) && db.stmt("SELECT 1 FROM log WHERE kind = 'basis.withdrawn' AND json_extract(record, '$.line') = ?").get(id) === undefined && (e.event === 'constraint' || db.stmt("SELECT 1 FROM missions WHERE mission = ? AND state = 'closed'").get(e.mission) === undefined)) out.set(id, {id, mission: e.mission, kind: e.event, line: id, words, ...(e.event === 'item' ? {itemType: String(b.type)} : {})});
    } else if (e.event === 'reviews-waiver') {
      if (b.action === 'withdraw') { for (const [id, d] of out) if (d.kind === 'waiver' && d.mission === e.mission && (b.scopeOnly !== true || d.line === String(b.dplan ?? 'mission'))) out.delete(id); }
      else {
        for (const [id, d] of out) if (d.kind === 'waiver' && d.mission === e.mission && d.line === String(b.dplan ?? 'mission')) out.delete(id);
        if (b.by === 'words' && wanted.has(b.ref)) {
          const id = `waiver:${e.mission}:${e.key}`;
          out.set(id, {id, mission: e.mission, kind: 'waiver', line: String(b.dplan ?? 'mission'), key: e.key, words: b.ref});
        }
      }
    }
  }
  return [...out.values()];
}

/**
 * 4.4 (G7): what gives power is accounted for one by one. An authorization item and a waiver must
 * be named withdrawn or kept, as in 4.3 (Appendix B.3 of the 4.3 design): a waiver for a whole
 * mission applies to the next plan while any tag of its entry is in force.
 */
export function givesPower(d: WordsDependency): boolean {
  return d.kind === 'waiver' || d.itemType === 'authorization';
}

/** What a supersession or a re-tag kept, while it still rests on the entry it named (4.4, G7). */
export interface KeptOnChangedWords {readonly id: string; readonly words: string; readonly how: 'superseded' | 're-tagged'; readonly tags: readonly string[]; readonly by: string}

/** The changed entries of one tags record: the superseded tags' entries, and the entry itself when it was re-tagged. */
function changedEntries(r: Extract<ResidentEvent, {kind: 'user.words-tags'}>): Set<string> {
  return new Set([...r.supersedes.map((id) => id.split('#')[0]!), ...(r.authorizedBy !== null ? [r.words] : [])]);
}

/**
 * 4.4 (G7): the dependents a supersession or a re-tag kept, by id, while each still rests on the entry
 * that changed and is not withdrawn. Reads mark them "rests on words that were superseded". A 4.3
 * record names nothing it kept, so it marks nothing, as 4.3 did.
 */
export function keptOnChangedWords(db: Db, data: Texts): Map<string, KeptOnChangedWords> {
  const records = residentRecords(db, 'user.words-tags').filter((r) => (r.kept?.length ?? 0) > 0);
  const out = new Map<string, KeptOnChangedWords>();
  if (records.length === 0) return out;
  const deps = new Map(wordsDependencies(db, data, [...new Set(records.flatMap((r) => [...changedEntries(r)]))]).map((d) => [d.id, d]));
  for (const r of records) {
    const entries = changedEntries(r);
    for (const id of r.kept!) {
      const d = deps.get(id);
      if (d?.words === undefined || !entries.has(d.words)) continue;
      const retagged = r.authorizedBy !== null && d.words === r.words;
      out.set(id, {id, words: d.words, how: retagged ? 're-tagged' : 'superseded', tags: retagged ? [] : r.supersedes.filter((t) => t.startsWith(`${d.words}#`)), by: retagged ? r.authorizedBy! : r.words});
    }
  }
  return out;
}

/** The mark a read prints on a kept dependent. */
export function keptMark(k: KeptOnChangedWords): string {
  return k.how === 'superseded' ? `rests on words that were superseded (${k.tags.join(', ')}, by ${k.by})` : `rests on words that were re-tagged (${k.words}, on ${k.by})`;
}

function event(tx: WriteTx, mission: string, line: string, name: string, key: string, body: unknown): void {
  appendRecords(tx, [{kind: 'flow.event', mission: mission as MissionId, line, event: name, key, body: tx.data.put(canonicalJson(body)) as ContentHash}]);
}

/** Entry-level disposition and tags are one append. Completed proof is never rewritten. */
export interface AssignTagsOptions {op: string; words: string; tags: readonly string[]; supersedes?: readonly string[]; retag?: string; authorizedBy?: string; withdraw?: readonly string[]; keep?: readonly string[]}
/** What a tagging wrote (4.4, G7): its tags, and the dependents of the changed entries it kept or withdrew. */
export interface TagsReport {readonly tags: WordsTag[]; readonly kept: readonly WordsDependency[]; readonly withdrawn: readonly WordsDependency[]; readonly how: 'superseded' | 're-tagged' | null}
export function assignTags(memory: Memory, o: AssignTagsOptions): WordsTag[] {
  return tagWords(memory, o).tags;
}
export function tagWords(memory: Memory, o: AssignTagsOptions): TagsReport {
  const r = memory.write({op: `words:tags:${o.op}`, payload: o, command: o.retag === undefined ? 'tag' : 'retag'}, (tx) => tagWordsInTx(tx, o)) as TagsReport | WordsTag[];
  // an operation recorded by 4.3 answered with its tags alone
  return Array.isArray(r) ? {tags: r, kept: [], withdrawn: [], how: null} : r;
}
export function assignTagsInTx(tx: WriteTx, o: AssignTagsOptions): WordsTag[] {
  return tagWordsInTx(tx, o).tags;
}
export function tagWordsInTx(tx: WriteTx, o: AssignTagsOptions): TagsReport {
    const entry = wordsEntry(tx, o.words);
    if (entry === null) notAllowed(`no words entry ${o.words}`);
    const before = taggedWords(tx, tx.data);
    const old = before.find((w) => w.words === o.words)!;
    let supersedes = [...new Set(o.supersedes ?? [])];
    // 4.4 (G7): an entry that has its tags takes --supersedes later, its tags unchanged (no --tag, or the same tags)
    const later = o.retag === undefined && old.tags.length !== 0;
    if (later) {
      const same = o.tags.length === 0 || canonicalJson(old.tags.map((t) => ({type: t.type, mission: t.mission, quote: t.quote}))) === canonicalJson(o.tags.map((t) => parseTag(t, old.text)));
      if (!same) notAllowed(`${o.words} already has tags; retag requires the user's authorization`);
      const already = new Set(residentRecords(tx, 'user.words-tags').filter((r) => r.words === o.words).flatMap((r) => r.supersedes));
      supersedes = supersedes.filter((id) => !already.has(id));
      if (supersedes.length === 0) return {tags: [...old.tags], kept: [], withdrawn: [], how: null};
    }
    if (o.retag !== undefined && (o.authorizedBy === undefined || wordsEntry(tx, o.authorizedBy) === null)) notAllowed('retag requires --words W-n with the user’s authorization');
    if (o.retag !== undefined && !old.tags.some((t) => t.id === o.retag)) notAllowed(`no tag ${o.retag}`);
    for (const id of supersedes) if (!before.some((w) => w.tags.some((t) => t.id === id && t.inForce))) notAllowed(`no tag in force ${id}`);
    const dependentEntries = [...new Set([...supersedes.map((id) => id.split('#')[0]!), ...(o.retag === undefined ? [] : [o.words])])];
    const deps = wordsDependencies(tx, tx.data, dependentEntries);
    const withdraw = new Set(o.withdraw ?? []), keep = new Set(o.keep ?? []);
    // 4.4 (G7): a requirement item or a constraint the command does not name is kept; nothing is withdrawn
    // implicitly. An authorization or a waiver gives power and is still named withdrawn or kept, as in 4.3.
    const missing = deps.filter((d) => (givesPower(d) && withdraw.has(d.id) === keep.has(d.id)) || (withdraw.has(d.id) && keep.has(d.id)));
    const unknown = [...withdraw, ...keep].filter((id) => !deps.some((d) => d.id === id));
    if (missing.length > 0 || unknown.length > 0) throw Object.assign(new Error(`choose --withdraw-items or --keep-items for each authorization and waiver resting on ${dependentEntries.join(', ')}: ${missing.map((d) => d.id).join(', ') || 'none'}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}. Requirement items and constraints not named are kept`), {code: 'NOT_ALLOWED', detail: {dependencies: deps, toName: deps.filter(givesPower).map((d) => d.id)}});
    const parsed = later ? old.tags.map((t) => ({type: t.type, mission: t.mission, quote: t.quote})) : o.tags.map((t) => parseTag(t, old.text));
    if (parsed.length === 0) notAllowed('at least one --tag is required');
    for (const t of parsed) if (t.mission !== null && tx.stmt('SELECT 1 FROM missions WHERE mission = ?').get(t.mission) === undefined) notAllowed(`no mission ${t.mission}`);
    const tags: WordsTag[] = later ? old.tags.map((t) => ({id: t.id, type: t.type, mission: t.mission, quote: t.quote})) : o.retag === undefined ? parsed.map((t, i) => ({...t, id: `${o.words}#${i + 1}`})) : old.tags.flatMap((t) => t.id === o.retag ? parsed.map((p, i) => ({...p, id: i === 0 ? t.id : `${o.words}#${old.tags.length + i}`})) : [{id: t.id, type: t.type, mission: t.mission, quote: t.quote}]);
    const kept = deps.filter((d) => !withdraw.has(d.id));
    for (const dep of deps.filter((d) => withdraw.has(d.id))) {
      if (dep.kind === 'waiver') {
        // Scope-specific withdrawal; other active waivers remain in force.
        const rows = tx.stmt("SELECT key, body FROM flow_events WHERE mission = ? AND line = 'plan' AND event = 'reviews-waiver' ORDER BY revision").all(dep.mission) as {key: string; body: string}[];
        const n = rows.length + 1;
        event(tx, dep.mission, 'plan', 'reviews-waiver', `plan-reviews#${n}`, {check: 'plan-reviews', n, action: 'withdraw', dplan: dep.line === 'mission' ? null : dep.line, by: 'words', ref: o.authorizedBy ?? o.words, reason: `withdrawn with ${dependentEntries.join(', ')}`, scopeOnly: true});
      } else {
        appendRecords(tx, [{kind: 'basis.withdrawn', line: dep.line as BasisLineId}]);
        event(tx, dep.mission, 'requirements', dep.kind === 'item' ? 'withdrawn' : 'constraint-withdrawn', dep.line, {line: dep.line, reason: `withdrawn with words tags by ${o.authorizedBy ?? o.words}`});
        if (dep.kind === 'item') {
          const line = `reqset.${dep.mission}`;
          const baseRows = (tx.stmt("SELECT record FROM log WHERE kind = 'basis.version' ORDER BY rev").all() as {record: string}[]).map((r) => JSON.parse(r.record) as {line: string; version: string});
          const n = baseRows.filter((b) => b.line === line).length + 1;
          const latest = new Map<string, string>();
          for (const b of baseRows) if (b.line.startsWith(`item.${dep.mission}.`)) latest.set(b.line, b.version);
          const items = [...latest].filter(([id]) => tx.stmt("SELECT 1 FROM log WHERE kind = 'basis.withdrawn' AND json_extract(record, '$.line') = ?").get(id) === undefined).map(([, version]) => version);
          appendRecords(tx, [{kind: 'basis.version', basisKind: 'requirement-set', line: line as BasisLineId, version: `${line}.v${n}` as BasisVersionId, mission: dep.mission as MissionId, scope: null, snapshot: tx.data.putList(items)}]);
        }
      }
    }
    tx.append({kind: 'user.words-tags', words: o.words, tags, supersedes, authorizedBy: o.authorizedBy ?? null, ...(kept.length > 0 ? {kept: kept.map((d) => d.id)} : {})});
    return {tags, kept, withdrawn: deps.filter((d) => withdraw.has(d.id)), how: o.retag !== undefined ? 're-tagged' : supersedes.length > 0 ? 'superseded' : null};
}

/** The lines a tagging command prints about what it kept and withdrew (4.4, G7). */
export function tagsReportLines(r: Pick<TagsReport, 'kept' | 'withdrawn' | 'how'>): string[] {
  const label = (d: WordsDependency) => `${d.id}${d.kind === 'waiver' ? ' (waiver)' : d.itemType === 'authorization' ? ' (authorization)' : ''}`;
  return [
    ...(r.kept.length > 0 ? [`Kept, resting on words that were ${r.how === 're-tagged' ? 're-tagged' : 'superseded'} (reads mark them): ${r.kept.map(label).join(', ')}. To withdraw one later: mp pm requirement withdraw or mp pm constraint withdraw, on the user's words.`] : []),
    ...(r.withdrawn.length > 0 ? [`Withdrawn: ${r.withdrawn.map(label).join(', ')}.`] : []),
  ];
}

export function summarizeWords(memory: Memory, o: {op: string; text: string; covers: readonly string[]}): string {
  return memory.write({op: `words:summary:${o.op}`, payload: o, command: 'summary'}, (tx) => {
    if (o.text.trim() === '' || o.covers.length === 0) notAllowed('a summary needs text and every tag id it covers');
    const tags = taggedWords(tx, tx.data).flatMap((w) => w.tags);
    const covers = [...new Set(o.covers)].map((id) => {const t = tags.find((t) => t.id === id && t.inForce); if (t === undefined) notAllowed(`no tag in force ${id}`); return {id, fingerprint: t.fingerprint};});
    const id = `summary-${residentRecords(tx, 'words.summary').length + 1}`;
    tx.append({kind: 'words.summary', id, text: o.text, covers});
    return id;
  });
}
