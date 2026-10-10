// Fixture card kinds for the seat host's profile tests (test/seat-host-profiles.test.ts,
// test/seat-profiles.test.ts): one kind per tool profile of the registry (src/seat/cards/
// registry.ts), each on a different seat of design 2, so the host's dispatch by kind, its
// tools per profile and its model per seat are tested independently of the real card modules
// (which other owners are still writing). The seat host imports this module through its
// test-only `cardModules` config.
//
// Every fixture kind hands back { summary, finding? }. Its own rule refuses the summary "bad";
// it deliberately does NOT check the must-read list (the host must enforce it itself). An
// accepted hand-back with a finding becomes one issue record (its words a document, observed on
// `fixture-target`), so the host's submission of an entry's records is visible.

import { z } from 'zod';
import type { IssueId, ModuleId } from '../src/common/ids.ts';
import type { BaseRecord, IssueRecord } from '../src/common/records.ts';
import { validateRecord } from '../src/common/validate.ts';
import { Command, Material, ReadOnlyWorkspace, Workspace, commonCardFields, renderCommon, renderMaterials } from '../src/seat/cards/common.ts';
import { registerSeatCard, seatCardKinds, type CardRecordContext, type SeatCardEntry, type SeatName, type ToolProfile } from '../src/seat/cards/registry.ts';

export const FixtureResultShape = {
  summary: z.string().min(1).describe('What you found.'),
  finding: z.string().optional().describe('A problem worth an issue record.'),
};
const FixtureResultSchema = z.object(FixtureResultShape);
export type FixtureResult = z.infer<typeof FixtureResultSchema>;

type FixtureCard = { readonly seat: string; readonly mission: string; readonly module: string | null; readonly launch: string } & Record<string, unknown>;

export const FIXTURE_TARGET = 'fixture-target';

export function fixtureDefinition(kind: string): string {
  return `You are the fixture seat ${kind}. Follow the card; hand back a summary with submit_result.`;
}

function records(card: FixtureCard, r: FixtureResult, ctx: CardRecordContext): BaseRecord[] {
  if (r.finding === undefined) return [];
  const text = ctx.content.put(JSON.stringify({ format: 'mp4.fixture-finding.v1', launch: ctx.launch, kind: card.seat, text: r.finding }));
  const rec: IssueRecord = {
    kind: 'issue',
    issue: `fixture:${text.slice(0, 16)}` as IssueId,
    module: card.module as ModuleId | null,
    observedOn: ctx.content.putList([FIXTURE_TARGET]),
    text: text as never,
  };
  validateRecord(rec);
  return [rec];
}

const KINDS: ReadonlyArray<{ readonly kind: string; readonly seat: SeatName; readonly profile: ToolProfile; readonly fields: z.ZodRawShape }> = [
  { kind: 'fixture-materials', seat: 'secretary', profile: 'materials', fields: { materials: z.array(Material) } },
  { kind: 'fixture-read', seat: 'architect', profile: 'read', fields: { workspace: ReadOnlyWorkspace } },
  { kind: 'fixture-rerun', seat: 'auditor', profile: 'read-rerun', fields: { workspace: ReadOnlyWorkspace, declaredCommands: z.array(Command) } },
  { kind: 'fixture-evidence', seat: 'crititor', profile: 'read-evidence', fields: { workspace: ReadOnlyWorkspace, materials: z.array(Material) } },
  { kind: 'fixture-web', seat: 'researcher', profile: 'read-web', fields: { workspace: ReadOnlyWorkspace, network: z.object({ allowed: z.array(z.string().min(1)), maxBytes: z.number().int().positive().optional() }) } },
  { kind: 'fixture-write', seat: 'constructor', profile: 'write', fields: { workspace: Workspace } },
];

if (!seatCardKinds().includes('fixture-read')) {
  for (const k of KINDS) {
    const entry: SeatCardEntry<FixtureCard, FixtureResult> = {
      kind: k.kind,
      seat: k.seat,
      schema: z.object({ ...commonCardFields, seat: z.literal(k.kind), ...k.fields }) as unknown as z.ZodType<FixtureCard>,
      resultShape: FixtureResultShape,
      resultSchema: FixtureResultSchema,
      definition: fixtureDefinition(k.kind),
      toolProfile: k.profile,
      render: (c) =>
        renderCommon(c as never) +
        `## Fixture task (${k.kind})\nDo what the duties say, then hand back.\n\n` +
        renderMaterials(((c as { materials?: unknown }).materials ?? []) as never) +
        'When done, call submit_result once, then end your turn.',
      problems: (_c, r) => (r.summary === 'bad' ? ['summary: "bad" is not a summary (fixture rule)'] : []),
      records,
    };
    registerSeatCard(entry);
  }
}

export const FIXTURE_KINDS = KINDS.map((k) => ({ kind: k.kind, seat: k.seat, profile: k.profile }));
