import { taggedWords, residentRecords } from '../memory/words.ts';
import { pmInbox, unconfirmedSeats } from '../process/secretary.ts';
import type { ProcessContext } from '../process/context.ts';

/** The PM's bounded first load. Summaries are PM prose, never words provenance. */
export function pmLayer1(ctx: ProcessContext): string {
  const all = taggedWords(ctx.memory, ctx.memory.data);
  const active = all.flatMap((w) => w.tags.filter((t) => t.inForce && t.type !== 'instruction').map((t) => ({...t, text: t.quote ?? w.text, words: w.words})));
  const summaries = residentRecords(ctx.memory, 'words.summary');
  const covered = new Set<string>();
  const summaryLines: {text: string; project: boolean}[] = [];
  for (const s of [...summaries].reverse()) {
    if (s.covers.every((c) => active.some((t) => t.id === c.id && t.fingerprint === c.fingerprint)) && !s.covers.some((c) => covered.has(c.id))) {
      // Principles retain precedence over all other material, including PM summaries.
      if (s.covers.some((c) => active.some((t) => t.id === c.id && t.type === 'principle'))) continue;
      s.covers.forEach((c) => covered.add(c.id));
      summaryLines.push({text: `[${s.id}] PM summary (not the user's words): ${s.text.replace(/\s+/g, ' ')}`, project: s.covers.some((c) => active.some((t) => t.id === c.id && t.mission === null))});
    }
  }
  const short = (s: string) => [...s.replace(/\s+/g, ' ')].slice(0, 160).join('');
  const principles = active.filter((t) => t.type === 'principle').map((t) => `[${t.id}] principle: ${short(t.text)}`);
  const tagged = active.filter((t) => t.type !== 'principle' && !covered.has(t.id));
  const tagLine = (t: typeof tagged[number]) => `[${t.id}] ${t.type}${t.mission === null ? ' project' : ` @${t.mission}`}: ${short(t.text)}`;
  const projectLines = [...summaryLines.filter((s) => s.project).map((s) => s.text), ...tagged.filter((t) => t.mission === null).map(tagLine)];
  const missionLines: {text: string; rev: number}[] = tagged.filter((t) => t.mission !== null).map((t) => ({text: tagLine(t), rev: all.find((w) => w.words === t.words)!.revision}));
  for (const s of summaryLines.filter((s) => !s.project)) missionLines.push({text: s.text, rev: Number(ctx.memory.head())});
  const missions = ctx.memory.stmt('SELECT mission, state FROM missions ORDER BY mission').all() as {mission: string; state: string}[];
  const flow = (ctx.memory.stmt('SELECT mission, line, event, key, body, revision FROM flow_events ORDER BY revision DESC').all() as {mission: string; line: string; event: string; key: string; body: string; revision: number}[]).map((r) => ({...r, body: JSON.parse(ctx.memory.data.text(r.body)) as any}));
  const withdrawn = new Set((ctx.memory.stmt("SELECT record FROM log WHERE kind = 'basis.withdrawn'").all() as {record: string}[]).map((r) => JSON.parse(r.record).line as string));
  const contested = new Map<string, boolean>();
  const scopes = new Map<string, {mission?: string}>();
  for (const e of flow) {
    if (e.event === 'contested' && !contested.has(e.body.line)) contested.set(e.body.line, e.body.contested === true);
    if (e.event === 'constraint-scope' && !scopes.has(e.body.line)) scopes.set(e.body.line, e.body.scope);
  }
  const seen = new Set<string>();
  for (const e of flow) {
    const b = e.body;
    const open = missions.some((m) => m.mission === e.mission && m.state === 'open');
    if (e.line === 'requirements' && e.event === 'constraint' && !seen.has(b.line)) {
      seen.add(b.line);
      const scope = scopes.get(b.line) ?? b.scope;
      if (!withdrawn.has(b.line) && (scope?.mission == null || missions.some((m) => m.mission === scope.mission && m.state === 'open'))) projectLines.push(`[${b.line}] constraint${scope?.mission ? ` @${scope.mission}` : ' project'}: ${short(b.text)}`);
    } else if (open && e.line === 'requirements' && e.event === 'item' && !withdrawn.has(b.line) && contested.get(b.line) !== true && !seen.has(b.line)) {
      seen.add(b.line); missionLines.push({text: `[${b.line}] @${e.mission} requirement ${b.type}: ${short(b.text)}`, rev: e.revision});
    } else if (open && e.line === 'plan' && e.event === 'effective' && !seen.has(`plan:${e.mission}`)) {
      seen.add(`plan:${e.mission}`); missionLines.push({text: `[${b.dplan}] @${e.mission} detailed plan in effect`, rev: e.revision});
    } else if (open && e.line === 'plan' && e.event === 'pm-plan-effective' && !seen.has(`pmplan:${e.mission}`)) {
      seen.add(`pmplan:${e.mission}`); missionLines.push({text: `[${b.plan}] @${e.mission} PM plan in effect`, rev: e.revision});
    } else if (open && e.line === 'secretary' && e.event === 'applied' && (b.by === 'pm' || b.by === 'user')) {
      missionLines.push({text: `[${e.mission}/${e.key}] decision by ${b.by}: ${b.what?.option ?? ''}${b.noWords ? '; by the PM, no words on record' : ''}`, rev: e.revision});
    }
  }
  for (const i of pmInbox(ctx)) projectLines.push(`[${i.id}] inbox ${i.state}: ${short(i.text)}; ${i.action}`);
  for (const d of unconfirmedSeats(ctx.memory)) projectLines.push(`[${d.dispatch}] unconfirmed seat (${d.mission}); stop ${d.stops.join(', ')}; release --ended after harness confirmation`);
  const other = [...projectLines, ...missionLines.sort((a, b) => b.rev - a.rev).map((l) => l.text)];
  const stops = Number((ctx.memory.stmt("SELECT COUNT(*) AS n FROM stops WHERE state = 'active'").get() as {n: number}).n);
  const flight = Number((ctx.memory.stmt("SELECT COUNT(*) AS n FROM dispatches WHERE state = 'in-flight'").get() as {n: number}).n);
  const status = `Status layer 0: ${missions.filter((m) => m.state === 'open').length} open mission(s); ${flight} dispatch(es) in flight; ${stops} stop(s); mp read status`;
  const header = 'PM memory — layer 1 (read by subject: mp read words; verbatim: mp read show words W-n)';
  const footerReserve = 580;
  const lines = [header];
  let omittedPrinciples = 0, omittedOther = 0;
  const add = (line: string): boolean => {
    if (Buffer.byteLength([...lines, line, status].join('\n'), 'utf8') + footerReserve > 8192) return false;
    lines.push(line); return true;
  };
  let principlesFull = false;
  for (const line of principles) {if (principlesFull || !add(line)) {principlesFull = true; omittedPrinciples++;}}
  if (omittedPrinciples === 0) {for (const line of other) if (!add(line)) omittedOther++;}
  else omittedOther = other.length;
  if (omittedPrinciples > 0) lines.push(`${omittedPrinciples} more principles in force: mp read words --tag principle --in-force. Read ALL before a PM-class decision; consolidate.`);
  if (omittedOther > 0) lines.push(`${omittedOther} more mission/project entries: mp read words --in-force; mp read status; mp pm inbox. Consolidate with mp pm summary.`);
  if (summaries.some((s) => !s.covers.every((c) => active.some((t) => t.id === c.id && t.fingerprint === c.fingerprint)))) lines.push('Stale summaries: surviving original tags are shown; write a new mp pm summary.');
  lines.push(status);
  return lines.join('\n');
}
