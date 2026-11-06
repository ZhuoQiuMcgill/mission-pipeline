import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flagBool, flagList, flagStr, positional } from '../args.ts';
import { ok, type Command, type RunContext } from '../command.ts';
import { refused, usage } from '../errors.ts';
import { INSTALLED_PLUGIN } from '../init.ts';
import { parseFiller } from '../../process/pm.ts';
import { seatRead } from '../../process/seat.ts';
import { claimSecretary, generations, notAllowed, requirePm, startSecretary, writeGeneration } from '../../memory/resident.ts';
import { assignTags, summarizeWords, taggedWords } from '../../memory/words.ts';
import { pmNote, pmQuestion, pmReply, pmInbox, markInbox, secNext, secWait, secCard, secDecide, secDecisionDispatch, secQuestion, secReply, secAckNote, shellQuote, stopSecretary } from '../../process/secretary.ts';
import { DECISION_OPTIONS, type DecisionOption } from '../../seat/cards/secretary.ts';
import { renderNext, PM_COMMANDS } from './pm.ts';

function P(c: RunContext) {if (c.project === null) throw usage('this command needs an initialized project'); return c.project;}
function op(c: RunContext): string {return c.op!;}

const secretary: Command = {
  group: 'pm', name: ['secretary'], summary: 'start, bind a harness handle, or retire a resident Secretary',
  usage: 'mp pm secretary start [--replace] [--handle <id>] | handle <S-n> <handle> | stop [--gone]',
  flags: {replace: 'boolean', handle: 'string', gone: 'boolean'},
  async run(c, args) {
    const p = P(c); requirePm(p.ctx.secretary);
    const sub = positional(args, 0, 'start|handle|stop');
    if (sub === 'start') {
      const g = startSecretary(p.ctx.memory, {op: op(c), name: `${p.config.projectName ?? basename(p.dir)}-Secretary`, replace: flagBool(args, 'replace'), handle: flagStr(args, 'handle')});
      const prompt = `You are ${g.name}, the resident Secretary of Mission Pipeline. Your handbook: mp sec handbook. Run mp sec session, then loop on mp sec next / mp sec wait.`;
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
    if (sub === 'stop') {const r = stopSecretary(p.ctx, {op: op(c), gone: flagBool(args, 'gone')}); return ok(`${r.generation} retired; the PM’s 4.2 loop is available.\n${r.stopHint}`, r);}
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
  group: 'sec', name: ['next'], summary: 'reconcile; stops, PM exchanges, notices, ready work and dispatches', usage: 'mp sec next', flags: {}, decides: true,
  async run(c) {const p = P(c); const r = await secNext(p.ctx); const lines = [
    `Stops: ${r.stops.map((s) => `${s.stop} (${JSON.stringify(s.scope)})`).join(', ') || 'none'}`,
    `Unconfirmed seats: ${r.unconfirmed.map((d) => `${d.dispatch} (${d.mission}; ${d.stops.join(', ')})`).join(', ') || 'none'}`,
    ...r.notes.map((n) => `[${n.id}] PM note: ${n.text}; mp sec ack-note ${n.id}`), ...r.questions.map((q) => `[${q.id}] PM question: ${q.text}; mp sec reply ${q.id} "<answer>"`),
    ...r.replies.map((r) => `[${r.id}] PM reply to ${JSON.stringify(r.question)}${r.about ? ` (about ${r.about})` : ''}: ${r.text}${r.words ? ` (${r.words})` : ''}`),
    ...r.decisions.map((e: any) => `[${e.mission}/${e.key}] ${e.body.by} decision in effect: ${e.body.what?.option ?? ''}`), renderNext(p, r, p.config.fillers).replaceAll('mp pm ', 'mp sec '), `rev ${r.revision}`]; return ok(lines.join('\n'), r);},
};
const wait: Command = {
  group: 'sec', name: ['wait'], summary: 'wait for an actionable revision, checking liveness every 30 s', usage: 'mp sec wait --since <R> [--timeout <seconds>]', flags: {since: 'string', timeout: 'string'},
  async run(c, a) {const since = Number(flagStr(a, 'since') ?? 'NaN'), timeout = Number(flagStr(a, 'timeout') ?? '300'); if (!Number.isSafeInteger(since) || since < 0 || !Number.isFinite(timeout) || timeout < 0) throw usage('--since is a nonnegative revision; --timeout is nonnegative seconds'); const r = await secWait(P(c).ctx, {since, timeout}); return ok([`rev ${r.revision}${r.timedOut ? ' (timeout)' : ''}${r.unconfirmed.length ? `; unconfirmed seats: ${r.unconfirmed.map((d) => d.dispatch).join(', ')}` : ''}`, ...r.replies.map((r) => `[${r.id}] PM reply: ${r.text}${r.words ? ` (${r.words})` : ''}`)].join('\n'), r);},
};
const card: Command = {
  group: 'sec', name: ['card'], summary: 'claim the current decision round and read its card', usage: 'mp sec card <escalation>', flags: {},
  async run(c, a) {const r = secCard(P(c).ctx, positional(a, 0, 'escalation')); return ok(r.card, r);},
};
const read: Command = {
  group: 'sec', name: ['read'], summary: 'record a material read against this round’s decision dispatch', usage: 'mp sec read <escalation> <material> [--page n]', flags: {page: 'string'},
  async run(c, a) {const p = P(c); const page = Number(flagStr(a, 'page') ?? '1'); if (!Number.isSafeInteger(page) || page < 1) throw usage('--page is a positive integer'); const r = seatRead(p.ctx, secDecisionDispatch(p.ctx, positional(a, 0, 'escalation')), positional(a, 1, 'material'), page); return ok(r.text, r);},
};
const decide: Command = {
  group: 'sec', name: ['decide'], summary: 'hand the current round back with the validated decision', usage: 'mp sec decide <escalation> --option <option> --classification detail|needs-pm --reason "…" [--instructions "…"] [--extra n] [--authorization <item>] [--notice "…"] [--may-matter]',
  flags: {option: 'string', classification: 'string', reason: 'string', instructions: 'string', extra: 'string', findings: 'list', authorization: 'string', notice: 'string', 'may-matter': 'boolean'},
  async run(c, a) {const option = flagStr(a, 'option'); const classification = flagStr(a, 'classification') ?? (option === 'ask-pm' || option === 'ask-user' ? 'needs-pm' : 'detail'); if (!(DECISION_OPTIONS as readonly string[]).includes(option ?? '') || (classification !== 'detail' && classification !== 'needs-pm')) throw usage('choose an offered --option and --classification detail|needs-pm'); const r = await secDecide(P(c).ctx, positional(a, 0, 'escalation'), {option: option as DecisionOption, classification, reason: flagStr(a, 'reason') ?? '', instructions: flagStr(a, 'instructions') ?? '', grantExtra: Number(flagStr(a, 'extra') ?? '0'), findings: [...flagList(a, 'findings')], authorization: flagStr(a, 'authorization'), notice: flagStr(a, 'notice') ?? (classification === 'needs-pm' ? flagStr(a, 'reason') ?? '' : ''), mayMatter: flagBool(a, 'may-matter')}); if (r.kind === 'refused') throw refused('NOT_ALLOWED', r.problems.join('; '), null, {problems: r.problems}); return ok(JSON.stringify(r), r);},
};
const reply: Command = {group: 'sec', name: ['reply'], summary: 'answer a PM progress question', usage: 'mp sec reply <Q-n> "<text>"', flags: {}, async run(c, a) {const id = positional(a, 0, 'question'); secReply(P(c).ctx, {op: op(c), id, text: a.positionals.slice(1).join(' ')}); return ok(`${id} answered.`, {id});}};
const askPm: Command = {group: 'sec', name: ['ask-pm'], summary: 'ask the PM an operational question without an escalation', usage: 'mp sec ask-pm "<question>" [--about <notice or item id>]', flags: {about: 'string'}, async run(c, a) {const id = secQuestion(P(c).ctx, {op: op(c), text: a.positionals.join(' '), about: flagStr(a, 'about')}); return ok(`Question ${id} sent to the PM inbox.`, {id});}};
const pmReplyCommand: Command = {group: 'pm', name: ['reply'], summary: 'answer a Secretary question', usage: 'mp pm reply <SQ-n> "<text>" [--words W-n]', flags: {words: 'string'}, async run(c, a) {const id = positional(a, 0, 'question'); pmReply(P(c).ctx, {op: op(c), id, text: a.positionals.slice(1).join(' '), words: flagStr(a, 'words')}); return ok(`${id} answered; the Secretary sees it in next/wait.`, {id});}};
const ack: Command = {group: 'sec', name: ['ack-note'], summary: 'acknowledge a PM instruction note', usage: 'mp sec ack-note <N-n>', flags: {}, async run(c, a) {const id = positional(a, 0, 'note'); secAckNote(P(c).ctx, {op: op(c), id}); return ok(`${id} acknowledged.`, {id});}};

const note: Command = {group: 'pm', name: ['note'], summary: 'record an instruction note to the Secretary', usage: 'mp pm note "<text>" [--words W-n]', flags: {words: 'string'}, async run(c, a) {const id = pmNote(P(c).ctx, {op: op(c), text: a.positionals.join(' '), words: flagStr(a, 'words')}); return ok(`Note ${id} recorded.`, {id});}};
const question: Command = {group: 'pm', name: ['ask-secretary'], summary: 'ask for progress details on the user’s request', usage: 'mp pm ask-secretary "<question>"', flags: {}, async run(c, a) {const id = pmQuestion(P(c).ctx, {op: op(c), text: a.positionals.join(' ')}); return ok(`Question ${id} recorded.`, {id});}};
const inbox: Command = {
  group: 'pm', name: ['inbox'], summary: 'pending PM decisions, notices and Secretary replies', usage: 'mp pm inbox [--asked-user <item>] [--ack <item>]', flags: {'asked-user': 'string', ack: 'string'},
  async run(c, a) {const p = P(c); const asked = flagStr(a, 'asked-user'), ack = flagStr(a, 'ack'); if (asked !== null || ack !== null) markInbox(p.ctx, {op: op(c), id: (asked ?? ack)!, asked: asked !== null}); const items = pmInbox(p.ctx); return ok(items.length ? items.map((i) => `[${i.id}] ${i.state}: ${i.text}${i.about ? ` (about ${i.about})` : ''}${i.options?.length ? ` (options: ${i.options.join(' / ')})` : ''}\n  Action: ${i.action}; resolved when ${i.resolution}`).join('\n') : 'PM inbox: empty.', {items});},
};
const tag: Command = {
  group: 'pm', name: ['tag'], summary: 'give an untyped legacy entry its first tags', usage: 'mp pm tag W-n --tag <type[@mission][:"quote"]> …', flags: {tag: 'repeat'},
  async run(c, a) {const tags = assignTags(P(c).ctx.memory, {op: op(c), words: positional(a, 0, 'words'), tags: flagList(a, 'tag')}); return ok(tags.map((t) => `[${t.id}] ${t.type}`).join('\n'), {tags});},
};
const retag: Command = {
  group: 'pm', name: ['retag'], summary: 'change a tag with the user’s authorization', usage: 'mp pm retag W-n#k --tag <type> --words W-m [--withdraw-items <ids>] [--keep-items <ids>]', flags: {tag: 'repeat', words: 'string', 'withdraw-items': 'list', 'keep-items': 'list'},
  async run(c, a) {const id = positional(a, 0, 'tag id'), auth = flagStr(a, 'words'); if (auth === null) throw usage('retag requires --words W-m'); const tags = assignTags(P(c).ctx.memory, {op: op(c), words: id.split('#')[0]!, retag: id, authorizedBy: auth, tags: flagList(a, 'tag'), withdraw: flagList(a, 'withdraw-items'), keep: flagList(a, 'keep-items')}); return ok(`Re-tagged ${id} on ${auth}.`, {tags});},
};
const summary: Command = {
  group: 'pm', name: ['summary'], summary: 'record PM prose summarizing every covered tag', usage: 'mp pm summary "<text>" --covers W-n#k[,W-m#k] [--file <file>]', flags: {covers: 'list', file: 'string'},
  async run(c, a) {const file = flagStr(a, 'file'); const id = summarizeWords(P(c).ctx.memory, {op: op(c), text: file === null ? a.positionals.join(' ') : readFileSync(file, 'utf8'), covers: flagList(a, 'covers')}); return ok(`${id} recorded (PM summary, never the user's words).`, {id});},
};

export const RESIDENT_PM_COMMANDS: readonly Command[] = [secretary, note, question, pmReplyCommand, inbox, tag, retag, summary];
export const SEC_COMMANDS: readonly Command[] = [session, handbook, next, wait, card, read, decide, askPm, reply, ack, ...['dispatch', 'release', 'drain', 'renew', 'alerts', 'ack'].map((name) => ({...PM_COMMANDS.find((c) => c.name[0] === name)!, group: 'sec' as const, usage: PM_COMMANDS.find((c) => c.name[0] === name)!.usage.replaceAll('mp pm ', 'mp sec ')}))];
