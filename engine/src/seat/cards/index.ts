// The seat-card registry entry point (design 2, 7.1, 9.3): importing this module registers every
// card kind; it re-exports the registry (registry.ts). The host imports this module only.
//
// Constructor and Reviewer keep their definitions in src/seat/card.ts and src/seat/results.ts;
// their entries here only point at them (the host keeps building the Reviewer's judgment and
// findings itself, so their `records` is empty).
//
// A module that adds card kinds calls registerSeatCard() (from ./registry.ts) at load and is
// imported once at the end of this file: one import line per module, the only edit other
// owners make here.

import { z } from 'zod';
import { ConstructorCardSchema, ReviewerCardSchema, SEAT_DEFINITIONS, renderCard, type ConstructorCard, type ReviewerCard } from '../card.ts';
import { ConstructorResultShape, ReviewerResultShape, resultProblems, type ConstructorResult, type ReviewerResult, type SnapshotFiles } from '../results.ts';
import { registerSeatCard, type SeatCardEntry } from './registry.ts';

export * from './registry.ts';

const NO_SNAPSHOT: SnapshotFiles = { lines: () => null };

const constructorEntry: SeatCardEntry<ConstructorCard, ConstructorResult> = {
  kind: 'constructor',
  seat: 'constructor',
  schema: ConstructorCardSchema,
  resultShape: ConstructorResultShape,
  resultSchema: z.object(ConstructorResultShape) as unknown as z.ZodType<ConstructorResult>,
  definition: SEAT_DEFINITIONS.constructor,
  toolProfile: 'write',
  exportsProduct: true,
  render: (c) => renderCard(c),
  problems: (c, r, ctx) => resultProblems(c, r, { snapshot: ctx.snapshot ?? NO_SNAPSHOT }),
  records: () => [],
};

const reviewerEntry: SeatCardEntry<ReviewerCard, ReviewerResult> = {
  kind: 'reviewer',
  seat: 'reviewer',
  schema: ReviewerCardSchema,
  resultShape: ReviewerResultShape,
  resultSchema: z.object(ReviewerResultShape) as unknown as z.ZodType<ReviewerResult>,
  definition: SEAT_DEFINITIONS.reviewer,
  toolProfile: 'read-rerun',
  render: (c) => renderCard(c),
  problems: (c, r, ctx) => resultProblems(c, r, { snapshot: ctx.snapshot ?? NO_SNAPSHOT }),
  // the host builds the Reviewer's judgment and findings itself (results.ts judgmentRecord, findingRecords)
  records: () => [],
};

registerSeatCard(constructorEntry);
registerSeatCard(reviewerEntry);

// ---------------------------------------------------------------- card modules (one import line each)

import './calibrator.ts';
import './architect.ts';
import './secretary.ts';
import './crititor.ts';
import './experiment.ts';
import './researcher.ts';
import './auditor.ts';
