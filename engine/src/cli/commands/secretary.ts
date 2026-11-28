import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flagBool, flagList, flagStr, GLOBAL_FLAGS, positional } from '../args.ts';
import { ok, type Command, type RunContext } from '../command.ts';
import { refused, usage } from '../errors.ts';
import { INSTALLED_PLUGIN } from '../init.ts';
import { parseFiller, storedCard, type Dispatched } from '../../process/pm.ts';
import { seatRead } from '../../process/seat.ts';
import { claimSecretary, generations, notAllowed, requirePm, startSecretary, writeGeneration } from '../../memory/resident.ts';
import { summarizeWords, tagWords, tagsReportLines, taggedWords } from '../../memory/words.ts';
import { keepNextReport, secNextSeen, storedNextReport, type SecretaryNext } from '../../process/secretary.ts';
import { escalationsNamedIn, pmNote, pmQuestion, pmReply, pmInbox, markInbox, secNext, secWait, secCard, secDecide, secDecisionDispatch, secQuestion, secReply, secAckNote, shellQuote, stopSecretary, type InboxBrief } from '../../process/secretary.ts';
import { DECISION_OPTIONS, type DecisionOption } from '../../seat/cards/secretary.ts';
import { renderNext, PM_COMMANDS } from './pm.ts';

function P(c: RunContext) {if (c.project === null) throw usage('this command needs an initialized project'); return c.project;}
function op(c: RunContext): string {return c.op!;}

const secretary: Command = {
  group: 'pm', name: ['secretary'], summary: 'start, bind a harness handle, or retire a resident Secretary',
  usage: 'mp pm secretary start [--replace] [--handle <id>] | handle <S-n> <handle> | stop [--gone | --idle]   (--idle: no mission open, nothing in flight)',
  flags: {replace: 'boolean', handle: 'string', gone: 'boolean', idle: 'boolean'},
  async run(c, args) {
    const p = P(c); requirePm(p.ctx.secretary);
    const sub = positional(args, 0, 'start|handle|stop');
    if (sub === 'start') {
      const g = startSecretary(p.ctx.memory, {op: op(c), name: `${p.config.projectName ?? basename(p.dir)}-Secretary`, replace: flagBool(args, 'replace'), handle: flagStr(args, 'handle')});
      const prompt = `You are ${g.name}, the resident Secretary of Mission Pipeline. Run mp sec session first; then read your handbook (mp sec handbook) and loop on mp sec next / mp sec wait.`;
      const launch = `MP_SECRETARY=${g.generation} claude --bg -n ${shellQuote(g.name)} ${shellQuote(prompt)}`;
      return ok(`${g.generation} pending: ${g.name}. Launch it in your harness with MP_SECRETARY=${g.generation}.\n${prompt}\nClaude Code launch hint: ${launch}\nRecord the handle: mp pm secretary handle ${g.generation} <handle>`, {generation: g.generation, state: g.state, name: g.name, env: {MP_SECRETARY: g.generation}, prompt, launchHint: launch});
    }
    if (sub === 'handle') {
      const id = positional(args, 1, 'generation'), handle = positional(args, 2, 'handle');
      p.ctx.memory.write({op: `secretary:handle:${op(c)}`, payload: {id, handle}, command: 'secretary handle'}, (tx) => {
        const g = generations(tx).find((g) => g.generation === id); if (g === undefined) notAllowed(`no generation ${id}`); writeGeneration(tx, {...g, handle});
      });
      return ok(`${id}: harness handle ${handle} recorded.`, {generation: id, handle});
    }
    if (sub === 'stop') {const r = stopSecretary(p.ctx, {op: op(c), gone: flagBool(args, 'gone'), ...(flagBool(args, 'idle') ? {idle: true} : {})}); return ok(`${r.generation} retired; the PM’s 4.2 loop is available.\n${r.stopHint}`, r);}
    throw usage('mp pm secretary start|handle|stop');
  },
};

const session: Command = {
  group: 'sec', name: ['session'], summary: 'claim the pending Secretary generation from MP_SECRETARY', usage: 'mp sec session [--filled-by <harness/model>]', flags: {'filled-by': 'string'},
  async run(c, a) {const p = P(c); const g = claimSecretary(p.ctx.memory, p.ctx.secretary, {op: op(c), filler: parseFiller(flagStr(a, 'filled-by'))}); return ok(`${g.name} (${g.generation}) live. Handbook: mp sec handbook. Next: mp sec next.`, g);},
};
const handbook: Command = {
  group: 'sec', name: ['handbook'], summary: 'read the resident Secretary handbook', usage: 'mp sec handbook', flags: {},
  async run(c) {const p = P(c); const local = join(p.dir, '.mission-pipeline', 'secretary', 'SECRETARY.md'); const path = existsSync(local) ? local : join(INSTALLED_PLUGIN, 'secretary', 'SECRETARY.md'); const text = readFileSync(path, 'utf8'); return ok(text, {path, text});},
};
const next: Command = {
  group: 'sec', name: ['next'], summary: 'reconcile; what changed since your last pass: stops, PM exchanges, notices, ready work and dispatches (--all: everything)', usage: 'mp sec next [--all] [--since <R>]', flags: {all: 'boolean', since: 'string'}, decides: true,
  async run(c, a) {const p = P(c); const s = flagStr(a, 'since'); const since = s === null ? null : Number(s); if (since !== null && (!Number.isSafeInteger(since) || since < 0)) throw usage('--since is a nonnegative revision');
    const [text, json] = renderSecNext(p, await secNext(p.ctx, {all: flagBool(a, 'all'), since, deferSeen: true})); return ok(text, json);},
  // 4.4 (F8): the action records the kept report's hash (or a receipt that it was too large to keep); a retry with the same --op prints it
  recorded: (c, r) => {const kept = keepNextReport(P(c).ctx, r.json as SecretaryNext); return 'report' in kept ? {exitCode: r.exitCode, text: `mp sec next: report ${kept.report}`, json: kept} : {exitCode: r.exitCode, text: `The report of this pass (${kept.bytes} bytes) was too large to keep for a replay; mp sec next --all prints everything.`, json: kept};},
  replay: (c, prior) => {const j = prior.json as {report?: unknown} | null; if (typeof j?.report !== 'string') return prior; const p = P(c); const [text, json] = renderSecNext(p, storedNextReport(p.ctx, j.report)); return ok(text, json);},
  // 4.4 (F8): only once the report is out are its notices marked delivered and the cursor moved: an interruption shows an item again, never loses it
  afterOutput: (c, r) => {const j = r.json as Partial<SecretaryNext> | null; if (j !== null && typeof j.revision === 'number' && Array.isArray(j.notices)) secNextSeen(P(c).ctx, j as SecretaryNext);},
};

/** The text of a `mp sec next` report, and the report as its JSON. */
function renderSecNext(p: ReturnType<typeof P>, r: SecretaryNext): [string, SecretaryNext] {
  const e = r.earlier;
  // 4.4 (F8): what the caller saw before is one count line each
  const earlier = [e.notices > 0 ? `${e.notices} earlier notice(s) still open (mp sec alerts)` : '', e.replies > 0 ? `${e.replies} earlier PM repl${e.replies === 1 ? 'y' : 'ies'}` : '', e.decisions > 0 ? `${e.decisions} earlier PM or user decision(s) in effect` : '', e.closedMissionSteps > 0 ? `${e.closedMissionSteps} queued step(s) of closed missions held` : ''].filter((x) => x !== '');
  const lines = [
    `Stops: ${r.stops.map((s) => `${s.stop} (${JSON.stringify(s.scope)})`).join(', ') || 'none'}`,
    `Unconfirmed seats: ${r.unconfirmed.map((d) => `${d.dispatch} (${d.mission}; ${d.stops.join(', ')})`).join(', ') || 'none'}`,
    ...r.notes.map((n) => `[${n.id}] PM note: ${n.text}; mp sec ack-note ${n.id}`), ...r.questions.map((q) => `[${q.id}] PM question: ${q.text}; mp sec reply ${q.id} "<answer>"`),
    ...r.replies.map((r) => `[${r.id}] PM reply to ${JSON.stringify(r.question)}${r.about ? ` (about ${r.about})` : ''}: ${r.text}${r.words ? ` (${r.words})` : ''}`),
    // 4.4 (F9): what waits on the user waits for the PM to record the answer (the Secretary has no answer command)
    ...r.decisions.map((e: any) => `[${e.mission}/${e.key}] ${e.body.by} decision in effect: ${e.body.what?.option ?? ''}`), renderNext(p, r, p.config.fillers, {resident: true}).replaceAll('mp pm ', 'mp sec '),
    ...(earlier.length > 0 ? [`Seen before (${r.since === null ? '' : `up to rev ${r.since}; `}mp sec next --all prints them): ${earlier.join('; ')}`] : []), `rev ${r.revision}`];
  return [lines.join('\n'), r];
}
const wait: Command = {
  group: 'sec', name: ['wait'], summary: 'wait for a change after R that calls for the Secretary (not a seat’s claim, read or refused hand-back), reconciling every 30 s', usage: 'mp sec wait --since <R> [--timeout <seconds>]', flags: {since: 'string', timeout: 'string'},
  async run(c, a) {const since = Number(flagStr(a, 'since') ?? 'NaN'), timeout = Number(flagStr(a, 'timeout') ?? '300'); if (!Number.isSafeInteger(since) || since < 0 || !Number.isFinite(timeout) || timeout < 0) throw usage('--since is a nonnegative revision; --timeout is nonnegative seconds'); const r = await secWait(P(c).ctx, {since, timeout}); return ok([`rev ${r.revision}${r.timedOut ? ' (timeout)' : ''}${r.unconfirmed.length ? `; unconfirmed seats: ${r.unconfirmed.map((d) => d.dispatch).join(', ')}` : ''}`, ...r.replies.map((r) => `[${r.id}] PM reply: ${r.text}${r.words ? ` (${r.words})` : ''}`)].join('\n'), r);},
};
/** 4.4 (F16): a card and the warnings of its size report (a result recorded without one has none). */
function cardWithWarnings(text: string, size: Dispatched['size'] | undefined): string {
  return [text, ...(size?.warnings ?? []).map((w) => `\nWarning: this card's ${w.replace(/^its /, '')}`)].join('\n');
}
const card: Command = {
  group: 'sec', name: ['card'], summary: 'claim the current decision round and read its card', usage: 'mp sec card <escalation>', flags: {},
  async run(c, a) {const r = await secCard(P(c).ctx, positional(a, 0, 'escalation')); return ok(cardWithWarnings(r.card, r.size), r);},
  // 4.4 (F17): the recorded result names the card's leaf and hash, not its text; a retry reads the leaf
  recorded: (_c, r) => {const {card: _text, ...rest} = r.json as Dispatched; return {exitCode: r.exitCode, text: `card ${rest.cardLeaf} (sha256 ${rest.cardSha256})`, json: rest};},
  replay: (c, prior) => {
    const j = prior.json as Partial<Dispatched> | null;
    if (j === null || typeof j.card === 'string' || typeof j.cardLeaf !== 'string' || typeof j.dispatch !== 'string') return prior;
    const text = storedCard(P(c).ctx, {dispatch: j.dispatch, cardLeaf: j.cardLeaf, worktree: null, ...(typeof j.cardSha256 === 'string' ? {cardSha256: j.cardSha256} : {})});
    // 4.4 (F16): the size warnings the first output printed come from the recorded size report
    return ok(cardWithWarnings(text, j.size), {...j, card: text});
  },
};
const read: Command = {
  group: 'sec', name: ['read'], summary: 'fetch one page of a material; the fetch is recorded against this round’s decision dispatch', usage: 'mp sec read <escalation> <material> [--page n]', flags: {page: 'string'},
  async run(c, a) {const p = P(c); const page = Number(flagStr(a, 'page') ?? '1'); if (!Number.isSafeInteger(page) || page < 1) throw usage('--page is a positive integer'); const r = seatRead(p.ctx, secDecisionDispatch(p.ctx, positional(a, 0, 'escalation')), positional(a, 1, 'material'), page); return ok(r.text, r);},
};
const decide: Command = {
  group: 'sec', name: ['decide'], summary: 'hand the current round back with the validated decision; it is recorded and carried out in the same command, and says what happened', usage: 'mp sec decide <escalation> --option <option> --classification detail|needs-pm --reason "…" [--instructions "…"] [--extra n] [--findings <ids>] [--authorization <item>] [--notice "…"] [--may-matter]   (with needs-pm, --notice is the PM’s brief: the question; the options and what each leads to; the user’s words that bear on it; what you would choose and why)',
  flags: {option: 'string', classification: 'string', reason: 'string', instructions: 'string', extra: 'string', findings: 'list', authorization: 'string', notice: 'string', 'may-matter': 'boolean'},
  async run(c, a) {const option = flagStr(a, 'option'); const classification = flagStr(a, 'classification') ?? (option === 'ask-pm' || option === 'ask-user' ? 'needs-pm' : 'detail'); if (!(DECISION_OPTIONS as readonly string[]).includes(option ?? '') || (classification !== 'detail' && classification !== 'needs-pm')) throw usage('choose an offered --option and --classification detail|needs-pm'); const r = await secDecide(P(c).ctx, positional(a, 0, 'escalation'), {option: option as DecisionOption, classification, reason: flagStr(a, 'reason') ?? '', instructions: flagStr(a, 'instructions') ?? '', grantExtra: Number(flagStr(a, 'extra') ?? '0'), findings: [...flagList(a, 'findings')], authorization: flagStr(a, 'authorization'), notice: flagStr(a, 'notice') ?? (classification === 'needs-pm' ? flagStr(a, 'reason') ?? '' : ''), mayMatter: flagBool(a, 'may-matter')}); if (r.kind === 'refused') throw refused('NOT_ALLOWED', r.problems.join('; '), null, {problems: r.problems});
    // 4.4 (F9): say what happened, as the seat way says it
    const head = r.repeated ? `Decision ${r.dispatch} was already recorded: nothing new.` : r.outcome !== 'accepted' ? `Decision ${r.dispatch} recorded but not accepted.` : `Decision ${r.dispatch} on ${positional(a, 0, 'escalation')}: ${r.decision?.text ?? 'recorded'}`;
    return ok([head, ...r.notes].join('\n'), r);},
};
const reply: Command = {group: 'sec', name: ['reply'], summary: 'answer a PM progress question', usage: 'mp sec reply <Q-n> "<text>"', flags: {}, async run(c, a) {const id = positional(a, 0, 'question'); secReply(P(c).ctx, {op: op(c), id, text: a.positionals.slice(1).join(' ')}); return ok(`${id} answered.`, {id});}};
const askPm: Command = {group: 'sec', name: ['ask-pm'], summary: 'ask the PM an operational question without an escalation', usage: 'mp sec ask-pm "<question>" [--about <notice or item id>]', flags: {about: 'string'}, async run(c, a) {const id = secQuestion(P(c).ctx, {op: op(c), text: a.positionals.join(' '), about: flagStr(a, 'about')}); return ok(`Question ${id} sent to the PM inbox.`, {id});}};
const pmReplyCommand: Command = {group: 'pm', name: ['reply'], summary: 'answer a Secretary question', usage: 'mp pm reply <SQ-n> "<text>" [--words W-n]', flags: {words: 'string'}, async run(c, a) {const id = positional(a, 0, 'question'); pmReply(P(c).ctx, {op: op(c), id, text: a.positionals.slice(1).join(' '), words: flagStr(a, 'words')}); return ok(`${id} answered; the Secretary sees it in next/wait.`, {id});}};
const ack: Command = {group: 'sec', name: ['ack-note'], summary: 'acknowledge a PM instruction note', usage: 'mp sec ack-note <N-n>', flags: {}, async run(c, a) {const id = positional(a, 0, 'note'); secAckNote(P(c).ctx, {op: op(c), id}); return ok(`${id} acknowledged.`, {id});}};

const note: Command = {
  group: 'pm', name: ['note'], summary: 'record a new instruction of the user as a note to the Secretary (an answer to an escalation is mp pm answer); --replaces takes an earlier note off the Secretary\'s list',
  usage: 'mp pm note "<text>" | mp pm note --file <file>   [--words W-n] [--replaces N-x]', flags: {words: 'string', replaces: 'string', file: 'string'},
  // 4.4 (G8): the identity 4.3 computed (positionals and the command's own flags), and the file's text only for a note from a file, so an operation id replays across the upgrade
  identity: (a) => {
    const flags = Object.fromEntries(Object.entries(a.flags).filter(([k]) => !(k in GLOBAL_FLAGS) && k !== 'filled-by'));
    const file = typeof a.flags['file'] === 'string' ? String(a.flags['file']) : null;
    return file === null ? {positionals: a.positionals, flags} : {positionals: a.positionals, flags, file: existsSync(file) ? readFileSync(file, 'utf8') : null};
  },
  async run(c, a) {
    const p = P(c); const file = flagStr(a, 'file'), replaces = flagStr(a, 'replaces');
    if (file !== null && a.positionals.length > 0) throw usage('give the note as text or with --file, not both');
    const text = file === null ? a.positionals.join(' ') : readFileSync(file, 'utf8');
    // the write's payload is 4.3's when --replaces is absent
    const id = pmNote(p.ctx, {op: op(c), text, words: flagStr(a, 'words'), ...(replaces !== null ? {replaces} : {})});
    // 4.4 (G8): a note that names an open escalation warns; it is still recorded
    const named = escalationsNamedIn(p.ctx.memory, text);
    const warnings = named.map((e) => `Warning: this note names the open escalation ${e.mission}/${e.escalation}. An answer in a note reaches no card and is not an answer record: answer it with mp pm answer ${e.mission} ${e.escalation} --option <option> --by pm|user.`);
    return ok([`Note ${id} recorded${replaces !== null ? `; it replaces ${replaces}, which the Secretary no longer sees as current` : ''}.`, ...warnings].join('\n'), {id, replaces, escalations: named, warnings});
  },
};
const question: Command = {group: 'pm', name: ['ask-secretary'], summary: 'ask for progress details on the user’s request', usage: 'mp pm ask-secretary "<question>"', flags: {}, async run(c, a) {const id = pmQuestion(P(c).ctx, {op: op(c), text: a.positionals.join(' ')}); return ok(`Question ${id} recorded.`, {id});}};
const inbox: Command = {
  group: 'pm', name: ['inbox'], summary: 'pending PM decisions, each with the Secretary’s brief, PM notices and Secretary replies', usage: 'mp pm inbox [--asked-user <item>] [--ack <item>]', flags: {'asked-user': 'string', ack: 'string'},
  async run(c, a) {const p = P(c); const asked = flagStr(a, 'asked-user'), ack = flagStr(a, 'ack'); if (asked !== null || ack !== null) markInbox(p.ctx, {op: op(c), id: (asked ?? ack)!, asked: asked !== null}); const items = pmInbox(p.ctx); return ok(items.length ? items.map((i) => [`[${i.id}] ${i.state}: ${i.text}${i.about ? ` (about ${i.about})` : ''}${i.options?.length && i.brief === undefined ? ` (options: ${i.options.join(' / ')})` : ''}`, ...(i.brief !== undefined ? briefLines(i.brief) : []), `  Action: ${i.action}; resolved when ${i.resolution}`].join('\n')).join('\n') : 'PM inbox: empty.', {items});},
};

/** 4.4 (G2): a decision item's brief, so the PM decides from the item and the user's words. */
function briefLines(b: InboxBrief): string[] {
  const indent = (s: string): string => s.trim().split('\n').join('\n    ');
  return [
    ...(b.notice.trim() !== '' ? [`  ${b.by === 'program' ? 'The program' : 'The Secretary'}'s notice:\n    ${indent(b.notice)}`] : []),
    ...(b.reason.trim() !== '' ? [`  Its reason: ${indent(b.reason)}`] : []),
    ...(b.handedOver !== undefined ? [`  Handed to you by the flow: ${indent(b.handedOver)}`] : []),
    ...(b.options.length > 0 ? ['  Options:', ...b.options.map((o) => `    ${o.id}: ${o.outcome}`)] : []),
    `  Rests on: items ${b.items.join(', ') || 'none named'}; words ${b.words.join(', ') || 'none named'}`,
    ...(b.revised ?? []).map((r) => `  The decision cites ${r.line} as ${r.decided}; ${r.current === null ? 'it is withdrawn since' : `it is ${r.current} now`} (the words of both are named above)`),
    ...(b.reasons.length > 0 ? [`  The escalation's reasons, shortened (in full: ${b.more}):`, ...b.reasons.map((r) => `    - ${r}`)] : []),
  ];
}
// 4.4 (G7): tag and retag take --supersedes too; what rests on the changed entries and is not named is kept and listed
const tag: Command = {
  group: 'pm', name: ['tag'], summary: 'give an untyped legacy entry its first tags, or name the tags an entry supersedes (its own tags unchanged)', usage: 'mp pm tag W-n --tag <type[@mission][:"quote"]> … [--supersedes W-m#k,…] [--withdraw-items <ids>] [--keep-items <ids>]\n       mp pm tag W-n --supersedes W-m#k,… [--withdraw-items <ids>] [--keep-items <ids>]   (an entry that has its tags)', flags: {tag: 'repeat', supersedes: 'list', 'withdraw-items': 'list', 'keep-items': 'list'},
  // the write's payload is 4.3's ({op, words, tags}) when the new flags are absent, so an operation id replays across the upgrade
  async run(c, a) {const r = tagWords(P(c).ctx.memory, {op: op(c), words: positional(a, 0, 'words'), tags: flagList(a, 'tag'), ...given('supersedes', flagList(a, 'supersedes')), ...given('withdraw', flagList(a, 'withdraw-items')), ...given('keep', flagList(a, 'keep-items'))}); return ok([...r.tags.map((t) => `[${t.id}] ${t.type}`), ...tagsReportLines(r)].join('\n'), r);},
};
/** A new option enters a write's payload only when it is given (4.4: a 4.3 payload stays as 4.3 hashed it). */
function given<K extends string>(key: K, list: readonly string[]): Partial<Record<K, readonly string[]>> {return list.length > 0 ? {[key]: list} as Record<K, readonly string[]> : {};}
const retag: Command = {
  group: 'pm', name: ['retag'], summary: 'change a tag with the user’s authorization', usage: 'mp pm retag W-n#k --tag <type> --words W-m [--supersedes W-j#k,…] [--withdraw-items <ids>] [--keep-items <ids>]', flags: {tag: 'repeat', words: 'string', supersedes: 'list', 'withdraw-items': 'list', 'keep-items': 'list'},
  async run(c, a) {const id = positional(a, 0, 'tag id'), auth = flagStr(a, 'words'); if (auth === null) throw usage('retag requires --words W-m'); const r = tagWords(P(c).ctx.memory, {op: op(c), words: id.split('#')[0]!, retag: id, authorizedBy: auth, tags: flagList(a, 'tag'), ...given('supersedes', flagList(a, 'supersedes')), withdraw: flagList(a, 'withdraw-items'), keep: flagList(a, 'keep-items')}); return ok([`Re-tagged ${id} on ${auth}.`, ...tagsReportLines(r)].join('\n'), r);},
};
const summary: Command = {
  group: 'pm', name: ['summary'], summary: 'record PM prose summarizing every covered tag', usage: 'mp pm summary "<text>" --covers W-n#k[,W-m#k] [--file <file>]', flags: {covers: 'list', file: 'string'},
  async run(c, a) {const file = flagStr(a, 'file'); const id = summarizeWords(P(c).ctx.memory, {op: op(c), text: file === null ? a.positionals.join(' ') : readFileSync(file, 'utf8'), covers: flagList(a, 'covers')}); return ok(`${id} recorded (PM summary, never the user's words).`, {id});},
};

export const RESIDENT_PM_COMMANDS: readonly Command[] = [secretary, note, question, pmReplyCommand, inbox, tag, retag, summary];
export const SEC_COMMANDS: readonly Command[] = [session, handbook, next, wait, card, read, decide, askPm, reply, ack, ...['dispatch', 'release', 'drain', 'renew', 'alerts', 'ack'].map((name) => ({...PM_COMMANDS.find((c) => c.name[0] === name)!, group: 'sec' as const, usage: PM_COMMANDS.find((c) => c.name[0] === name)!.usage.replaceAll('mp pm ', 'mp sec ')}))];
