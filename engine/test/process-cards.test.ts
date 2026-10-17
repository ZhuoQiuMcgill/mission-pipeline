// The cards of 4.1 (design 4.1 §5.2, §14 "Cards", r2 F7): every card kind renders with its seat's
// role page (roles/<seat>.md, the single source), the task's fields, the `mp seat <id>` commands
// it has, and the hand-back section with the JSON schema of its fields and the two file paths.
// No card names an interface 4.1 removed (the 4.0 seat host's tools, the sandbox, the session).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import { handBackSchema, renderSeatCard, seatCommandsOf } from '../src/seat/card.ts';
import { CARD_FORMAT, materialPageCount } from '../src/seat/cards/common.ts';
import { seatCardEntry, seatCardKinds } from '../src/seat/cards/index.ts';
import { INSTALLED_ROLES_DIR, roleText } from '../src/seat/cards/roles.ts';

const REMOVED = ['read_material', 'submit_result', 'run_command', 'write_file', 'no shell', 'sandbox', 'sessionId'];
const COMMIT = 'a'.repeat(40);
const LIST = { hash: sha256('[]'), count: 0 };
const BINDING = { judgment: 'j.1', bases: LIST, constraints: LIST, reliesOn: LIST, revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [] };
const doc = 'The material text.';
const MAT = { id: 'm1', title: 'A material', ref: sha256(doc), pages: materialPageCount(doc), mustRead: true };
const base = (task: string) => ({ format: CARD_FORMAT, task, mission: 'm1', module: null, capabilities: ['seat', 'model'], duties: 'Do the task on the card.', decisionQuotes: ['the user said so'], constraints: [] });
const XREF = { id: 'X1', product: 'design', research: false, focus: 'product', question: null };
const FINDING = { id: 'finding:1', severity: 'serious', class: 'internal contradiction', title: 'a hole', round: 1, material: 'm1', status: 'awaiting-recheck', disposition: { action: 'revise', note: 'changed', evidence: null, question: null }, ruling: null, scope: null };
const NEWV = { prefix: 'xpv.m1.X1.2', objectKind: 'interpretation', scope: { paths: ['exploration/m1.X1'], taskType: 'exploration' }, reviews: [{ review: 'crititor', basisLines: ['xpdef.m1.X1'], reliesOn: [] }], predecessor: null, prerequisites: [] };
const TASK = {
  id: 'impl',
  kind: 'implementation',
  module: 'core',
  goal: 'Implement it',
  standards: [{ id: 'S1', text: 'it works' }],
  requirementItems: ['item.m1.g1'],
  writeScope: ['src/**'],
  readableFiles: [],
  interpreter: 'node',
  verificationCommands: [{ id: 'test', command: 'npm test' }],
  implements: [],
  calls: [],
  dependsOn: [],
  exclusive: [],
  estimate: { durationMs: 1000, costMicros: 1, basis: 'small' },
  provenance: 'architect',
};
const PLAN = { reusedInterfaces: [], newInterfaces: [], modules: [{ id: 'core', writeScope: ['src/**'], provenance: 'architect' }], tasks: [TASK], risks: [] };
const BLIND = { steps: ['run it'], data: '', measure: ['time'], assertions: ['it ends'], evidence: { id: 'xpe.m1.X1.1', envLine: 'xpenv.m1.X1', envSnapshot: 'xpenv.m1.X1.1', attempt: null }, materials: [] };

/** One valid card of every kind (parsed by its kind's schema below). */
const SAMPLES: Record<string, Record<string, unknown>> = {
  constructor: {
    ...base('con.m1.impl.1'),
    seat: 'constructor',
    workspace: { snapshot: COMMIT, writablePaths: ['src/**'] },
    goal: 'Implement add',
    standards: [{ id: 'S1', text: 'add works' }],
    requirementItems: [{ id: 'item.m1.g1', text: 'An add function' }],
    readableFiles: ['README.md'],
    interpreter: 'node',
    verificationCommands: [{ id: 'check', command: 'node src/check.js' }],
    interfaces: { implements: [{ name: 'add', definition: 'add(a, b)' }], calls: [] },
  },
  reviewer: {
    ...base('rev.m1.impl.1'),
    seat: 'reviewer',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    target: 'prod.con.m1.impl.1',
    review: 'reviewer',
    standards: [{ id: 'S1', text: 'add works' }],
    interfaces: [],
    candidate: { changedPaths: ['src/add.js'] },
    verificationRuns: [{ evidence: 'run-1.check', command: 'node src/check.js', summary: 'completed; exit 0' }],
    declaredCommands: [{ id: 'check', command: 'node src/check.js' }],
    selfReportedGaps: [],
    openIssues: [],
    binding: BINDING,
  },
  'calibrator-1': { ...base('cal1.m1.1'), seat: 'calibrator-1', target: 'pmplan.m1.1', review: 'calibrator-1', mode: { kind: 'full' }, materials: [MAT], elements: [{ id: 'e1', text: 'add', provenance: 'user' }], focus: ['e1'], explorations: [], binding: BINDING },
  'calibrator-2': { ...base('cal2.m1.1'), seat: 'calibrator-2', target: 'dplan.m1.1.1', review: 'calibrator-2', pmPlan: 'pmplan.m1.1', mode: { kind: 'full' }, materials: [MAT], elements: [{ id: 't1', text: 'task', provenance: 'architect', mapsTo: null }], focus: ['t1'], binding: BINDING },
  'architect-decompose': {
    ...base('arch.m1.1.1'),
    seat: 'architect-decompose',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    pmPlan: { object: 'pmplan.m1.1', round: 1, order: 'free', elements: [{ id: 'e1', kind: 'deliverable', text: 'add', after: [] }], goalsBeyond: [] },
    requirementItems: [{ id: 'item.m1.g1', text: 'An add function' }],
    unsettledExplorations: [],
    explorationConclusions: [],
    history: { gitLog: 'abc first', runs: [] },
    revision: null,
    output: { object: 'dplan.m1.1.1', predecessor: null, path: 'plans/m1', calibrator2: { basisLines: [], reliesOn: [] }, feasibility: { basisLines: [], reliesOn: [] } },
  },
  'architect-repair': { ...base('arch-repair.m1.R-1.1'), seat: 'architect-repair', workspace: { snapshot: COMMIT, writablePaths: [] }, repair: { id: 'R-1', kind: 'defect', text: 'the header row is dropped', words: 'W-2', about: 'task impl' }, dplan: 'dplan.m1.1.1', pmPlan: 'pmplan.m1.1', elements: [{ id: 'e1', kind: 'deliverable', text: 'a parser' }], plan: PLAN, accepted: [{ task: 'impl', product: 'prod.con.m1.impl.1', attempt: 1, changedPaths: ['src/a.ts'] }], owners: [{ path: 'src/a.ts', owners: [{ task: 'impl', product: 'prod.con.m1.impl.1', attempt: 1, current: true }] }], history: { gitLog: '', runs: [] }, revision: null, materials: [MAT] },
  'architect-feasibility': { ...base('feas.m1.1.1'), seat: 'architect-feasibility', workspace: { snapshot: COMMIT, writablePaths: [] }, target: 'dplan.m1.1.1', review: 'feasibility', plan: PLAN, history: { gitLog: '', runs: [] }, earlierFindings: [], binding: BINDING },
  secretary: {
    ...base('sec.x'),
    seat: 'secretary',
    request: { id: 'x', source: 'loop-exhausted', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'reworks used up', original: '', changed: '', reasons: ['the same issue twice'] },
    authorizations: [{ id: 'item.m1.a1', quote: 'details are yours', notifyCondition: null }],
    items: [],
    materials: [MAT],
    options: [{ id: 'grant', label: 'Grant', outcome: 'one more round' }],
    grantAvailable: true,
    position: null,
  },
  crititor: {
    ...base('xp.m1.X1.2.attacker'),
    seat: 'crititor',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    exploration: XREF,
    goal: 'no obvious hole',
    attackScope: ['internal contradiction'],
    mode: 'attack',
    fresh: false,
    round: 2,
    target: 'xpv.m1.X1.1.abc',
    review: 'crititor',
    previousTarget: null,
    priorFindings: [FINDING],
    evidence: [],
    discussion: [],
    rulings: [],
    materials: [MAT],
    binding: BINDING,
    requiredEvidence: [],
    allowAsyncEvidence: true,
  },
  stabilizer: {
    ...base('xp.m1.X1.3.stabilizer'),
    seat: 'stabilizer',
    exploration: XREF,
    goal: 'no obvious hole',
    attackScope: ['internal contradiction'],
    decision: { type: 'structure', text: 'how to cache' },
    round: 1,
    target: 'xpv.m1.X1.1.abc',
    findings: [FINDING],
    earlier: [],
    firstVersion: { version: 'xpv.m1.X1.1.abc', material: 'm1' },
    currentVersion: { version: 'xpv.m1.X1.1.abc', material: 'm1' },
    earlierJudgments: [],
    rulings: [],
    materials: [MAT],
    binding: BINDING,
    requiredEvidence: [],
  },
  'researcher-author': {
    ...base('xp.m1.X1.1.author'),
    seat: 'researcher-author',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    exploration: XREF,
    goal: 'no obvious hole',
    attackScope: ['internal contradiction'],
    decision: { type: 'structure', text: 'how to cache' },
    round: 0,
    budgetRounds: 3,
    current: null,
    openFindings: [],
    otherFindings: [],
    evidence: [],
    discussion: [],
    rulings: [],
    materials: [],
    newVersion: NEWV,
    registerAttempts: false,
    allowAsyncEvidence: true,
    continuation: { previous: 'xp.m1.X1.0.author', notes: null, evidence: 'Evidence xpe.m1.X1.1 (completed): fine' },
  },
  'researcher-reader': { ...base('xp.m1.X1.4.executor'), seat: 'researcher-reader', workspace: { snapshot: COMMIT, writablePaths: [] }, network: { allowed: ['https://example.org/'] }, ...BLIND },
  'researcher-interpreter': {
    ...base('xp.m1.X1.5.interpreter'),
    seat: 'researcher-interpreter',
    workspace: { snapshot: COMMIT, writablePaths: [] },
    exploration: { ...XREF, research: true, focus: 'reasoning', product: 'answer', question: 'why?' },
    goal: 'an answer',
    attackScope: ['internal contradiction'],
    method: { version: 'xpv.m1.X1.1.abc', material: 'm1' },
    attempts: [{ id: 'A1', kind: 'experiment', purpose: 'measure', evidence: 'xpe.m1.X1.1', status: 'completed', summary: 'ok', material: null }],
    evidence: [],
    round: 2,
    budgetRounds: 3,
    current: null,
    openFindings: [],
    otherFindings: [],
    rulings: [],
    materials: [MAT],
    newVersion: NEWV,
  },
  'constructor-experiment': { ...base('xp.m1.X1.6.executor'), seat: 'constructor-experiment', workspace: { snapshot: COMMIT, writablePaths: [] }, interpreter: 'node', commands: [{ id: 'bench', command: 'node bench.js' }], ...BLIND },
  'auditor-node': {
    ...base('aud.m1.L1.1'),
    seat: 'auditor-node',
    workspace: { snapshot: COMMIT, writablePaths: [], scratchPaths: ['.'] },
    legalization: 'L1',
    target: { id: 'prod.x', kind: 'object', objectKind: 'product', label: 'not-fully-proven', boundary: false, paths: ['src/a.js'] },
    positions: [{ review: 'reviewer', reason: 'missing', bases: [{ id: 'std.S1', text: 'it works' }], constraints: [], binding: BINDING, prior: null, inheritedEvidence: [] }],
    evidence: [{ id: 'run-1.check', command: 'npm test', summary: 'exit 0' }],
    declaredCommands: [{ id: 'test', command: 'npm test' }],
    materials: [],
  },
  'auditor-chain': {
    ...base('aud.m1.L1.chain'),
    seat: 'auditor-chain',
    workspace: { snapshot: COMMIT, writablePaths: [], scratchPaths: [] },
    legalization: 'L1',
    chain: { object: 'chain.L1', endpoint: 'prod.x', nodes: [{ id: 'prod.x', kind: 'product', label: 'proven' }], excluded: [] },
    quotes: [{ id: 'q1', text: 'build it' }],
    seams: [],
    evidence: [],
    declaredCommands: [],
    materials: [],
    binding: BINDING,
  },
};

describe('cards: every kind renders the 4.1 way (§5.2, §14)', () => {
  it('a sample covers every registered kind', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), seatCardKinds());
  });

  for (const kind of Object.keys(SAMPLES)) {
    it(`${kind}: role page, commands, hand-back schema and files; no removed interface`, () => {
      const card = seatCardEntry(kind).schema.parse(SAMPLES[kind]) as { seat: string } & Record<string, unknown>;
      const text = renderSeatCard(card, { dispatch: 'D-7' });
      for (const word of REMOVED) assert.ok(!text.includes(word), `the ${kind} card names the removed interface "${word}"`);
      const entry = seatCardEntry(kind);
      // the role text comes from roles/<seat>.md (single source)
      const page = readFileSync(join(INSTALLED_ROLES_DIR, `${entry.seat}.md`), 'utf8');
      assert.ok(text.includes(page.split('\n').find((l) => l.startsWith('You '))!.slice(0, 60)), `the ${kind} card carries the ${entry.seat} role page`);
      assert.equal(entry.definition, roleText(entry.seat));
      // the seat's commands, each with the dispatch id
      for (const c of seatCommandsOf(card)) assert.match(text, new RegExp(`mp seat D-7 ${c}`));
      assert.match(text, /mp seat D-7 handback --report \.mission-pipeline\/tmp\/D-7\/report\.md --result \.mission-pipeline\/tmp\/D-7\/result\.json/);
      // the JSON schema of the structured fields
      const schema = JSON.stringify(handBackSchema(kind), null, 2);
      assert.ok(text.includes(schema), `the ${kind} card prints its fields' JSON schema`);
      assert.ok((handBackSchema(kind) as { type?: string }).type === 'object');
    });
  }

  it('the commands follow the profile: materials only; checkout; rerun of declared commands; request-evidence', () => {
    const cmds = (k: string) => seatCommandsOf(seatCardEntry(k).schema.parse(SAMPLES[k]) as never);
    assert.deepEqual(cmds('calibrator-1'), ['card', 'read', 'handback']);
    assert.deepEqual(cmds('stabilizer'), ['card', 'read', 'handback']);
    assert.deepEqual(cmds('constructor'), ['card', 'handback'], 'the Constructor works in its own worktree');
    assert.deepEqual(cmds('reviewer'), ['card', 'checkout', 'rerun', 'handback']);
    assert.deepEqual(cmds('crititor'), ['card', 'read', 'checkout', 'request-evidence', 'handback']);
    assert.deepEqual(cmds('constructor-experiment'), ['card', 'checkout', 'rerun', 'handback'], 'decision 11: the step commands run with rerun');
    assert.deepEqual(cmds('researcher-author'), ['card', 'checkout', 'request-evidence', 'handback']);
    // 4.1.2: a repair's Architect step may ask which accepted products changed a path
    assert.deepEqual(cmds('architect-repair'), ['card', 'read', 'checkout', 'owners', 'handback']);
  });

  it('a card never names a host path; a continuation names the previous task, not a session', () => {
    assert.throws(() => seatCardEntry('constructor').schema.parse({ ...SAMPLES['constructor'], workspace: { snapshot: '/tmp/snapshots/x', writablePaths: [] } }));
    const author = renderSeatCard(seatCardEntry('researcher-author').schema.parse(SAMPLES['researcher-author']) as never, { dispatch: 'D-9' });
    assert.match(author, /This card continues task xp\.m1\.X1\.0\.author/);
  });
});
